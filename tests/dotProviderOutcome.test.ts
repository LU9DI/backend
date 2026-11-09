/**
 * Classificação da falha do provedor de IA — fronteira entre "recusa" e
 * "resultado desconhecido".
 *
 * Regra: a lista de códigos HTTP só pode liberar reserva quando o erro é
 * ESTRUTURADO e originado no provedor ("Groq API error NNN" /
 * "Gemini API error NNN"). Mensagem genérica de proxy, gateway ou camada local
 * nunca é confundida com recusa do modelo. 408, 5xx e 429 são AMBÍGUOS por
 * padrão; um 429 só é recusa com evidência explícita de não processamento.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  classifyDotProviderError,
  describeDotProviderOutcome,
  isProvenNotSent,
  isProviderHttpRejection,
} from '../services/dotProviderOutcome.js';

function providerError(message: string, status: number): Error {
  const error: any = new Error(message);
  error.status = status;
  error.body = '';
  return error;
}

const suite = describe;

suite('Provedor de IA: recusa x resultado ambíguo', () => {
  test('429 estruturado é AMBÍGUO: não libera orçamento por padrão', () => {
    const groq = providerError('Groq API error 429: rate limit', 429);
    assert.equal(isProviderHttpRejection(groq), true);
    assert.equal(classifyDotProviderError(groq), 'ambiguous');
    assert.equal(isProvenNotSent('ambiguous', groq), false);

    const gemini = providerError('Gemini API error 429: RESOURCE_EXHAUSTED', 429);
    assert.equal(classifyDotProviderError(gemini), 'ambiguous');
    assert.equal(isProvenNotSent('ambiguous', gemini), false);
  });

  test('429 é recusa SOMENTE com evidência explícita de não processamento', () => {
    const error = providerError('Groq API error 429: rate limit; request not processed', 429);
    assert.equal(classifyDotProviderError(error), 'rejected');
    assert.equal(isProvenNotSent('rejected', error), true);
  });

  test('4xx de autenticação/pagamento/modelo do provedor é recusa', () => {
    for (const status of [400, 401, 402, 403, 404, 413, 422]) {
      const error = providerError(`Groq API error ${status}: rejeitado`, status);
      assert.equal(classifyDotProviderError(error), 'rejected', `status ${status}`);
      assert.equal(isProvenNotSent('rejected', error), true, `status ${status}`);
    }
  });

  test('5xx do provedor é ambíguo: a geração pode ter começado', () => {
    for (const status of [500, 502, 503, 504]) {
      const error = providerError(`Groq API error ${status}: interno`, status);
      assert.equal(classifyDotProviderError(error), 'ambiguous', `status ${status}`);
      assert.equal(isProvenNotSent('ambiguous', error), false, `status ${status}`);
    }
  });

  test('408 (Request Timeout) é ambíguo mesmo vindo do provedor', () => {
    const error = providerError('Groq API error 408: request timeout', 408);
    assert.equal(classifyDotProviderError(error), 'ambiguous');
    assert.equal(isProvenNotSent('ambiguous', error), false);
  });

  test('429 de um intermediário NÃO é confundido com recusa do modelo', () => {
    // Mensagem típica de proxy/gateway: tem status e até "HTTP 429", mas não
    // veio de `groqService.callGroq`/`callGemini`.
    const proxy = providerError('Upstream proxy error: HTTP 429 Too Many Requests', 429);
    assert.equal(isProviderHttpRejection(proxy), false);
    assert.equal(classifyDotProviderError(proxy), 'ambiguous');
    assert.equal(isProvenNotSent('rejected', proxy), false, 'mensagem arbitrária não libera reserva');

    const gateway: any = new Error('502 Bad Gateway from load balancer');
    gateway.status = 502;
    assert.equal(classifyDotProviderError(gateway), 'ambiguous');
  });

  test('erro sem status (timeout, conexão cortada) é ambíguo', () => {
    assert.equal(classifyDotProviderError(new Error('socket hang up')), 'ambiguous');
    assert.equal(classifyDotProviderError(new Error('ETIMEDOUT')), 'ambiguous');
    assert.equal(classifyDotProviderError(new Error('aborted')), 'ambiguous');
    assert.equal(classifyDotProviderError(new Error('Unexpected end of JSON input')), 'ambiguous');
  });

  test('ausência de provedor configurado é comprovadamente "não enviado"', () => {
    const error = new Error('Nenhuma IA configurada. Defina GROQ_API_KEY e/ou GEMINI_API_KEY no .env');
    assert.equal(classifyDotProviderError(error), 'not_sent');
    assert.equal(isProvenNotSent('not_sent'), true);
  });

  test('"rejected" sem o erro em mãos não é prova suficiente para liberar', () => {
    // Sem o objeto de erro não há como confirmar a origem: a função recusa
    // quando chamada com um erro arbitrário.
    const arbitrary = new Error('alguma falha qualquer');
    assert.equal(isProvenNotSent('rejected', arbitrary), false);
  });

  test('rótulos de telemetria são sanitizados e não expõem corpo de resposta', () => {
    assert.equal(
      describeDotProviderOutcome('not_sent'),
      'nenhum provedor de IA configurado; nada foi enviado',
    );
    assert.match(describeDotProviderOutcome('rejected'), /recusou/);
    assert.match(describeDotProviderOutcome('ambiguous'), /desconhecido/);
    for (const outcome of ['not_sent', 'rejected', 'ambiguous'] as const) {
      assert.ok(!/@/.test(describeDotProviderOutcome(outcome)));
    }
  });
  test('failover preserva tentativa ambígua anterior mesmo que o último provedor recuse', () => {
    const first = providerError('Groq API error 503: upstream failure', 503);
    const last = providerError('Gemini API error 401: invalid key', 401);
    const aggregate = new AggregateError([first, last], 'Falha em todos os providers');
    assert.equal(classifyDotProviderError(aggregate), 'ambiguous');
    assert.equal(isProvenNotSent('ambiguous', aggregate), false);
  });

  test('failover só libera quando TODAS as tentativas são recusas estruturadas', () => {
    const groq = providerError('Groq API error 401: invalid key', 401);
    const gemini = providerError('Gemini API error 403: forbidden', 403);
    const aggregate = new AggregateError([groq, gemini], 'Falha em todos os providers');
    assert.equal(classifyDotProviderError(aggregate), 'rejected');
    assert.equal(isProviderHttpRejection(aggregate), true);
    assert.equal(isProvenNotSent('rejected', aggregate), true);
  });

  test('failover com falha local não estruturada permanece ambíguo', () => {
    const groq = providerError('Groq API error 401: invalid key', 401);
    const local = new Error('socket hang up');
    const aggregate = new AggregateError([groq, local], 'Falha em todos os providers');
    assert.equal(classifyDotProviderError(aggregate), 'ambiguous');
    assert.equal(isProvenNotSent('ambiguous', aggregate), false);
  });

});
