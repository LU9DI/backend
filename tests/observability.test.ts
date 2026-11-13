import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  bindTenant,
  currentRequestId,
  logEvent,
  resetObservabilitySink,
  runWithObservability,
  sanitizeFields,
  scrubString,
  setObservabilitySink,
} from '../lib/observability.js';
import { getCounters, incCounter, recordHttp, resetCounters } from '../lib/metrics.js';

describe('observabilidade — correlação e logs estruturados', () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    setObservabilitySink((line) => lines.push(line));
    resetCounters();
  });

  afterEach(() => {
    resetObservabilitySink();
  });

  it('propaga request_id e empresa_id pelo contexto assíncrono', async () => {
    const record = await runWithObservability({ requestId: 'req-abc' }, async () => {
      bindTenant('empresa-42');
      await new Promise((resolve) => setTimeout(resolve, 1));
      return logEvent('info', 'test_event', { stage: 'unit' });
    });

    assert.equal(record.request_id, 'req-abc');
    assert.equal(record.empresa_id, 'empresa-42');
    assert.equal(lines.length, 1);

    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.event, 'test_event');
    assert.equal(parsed.request_id, 'req-abc');
    assert.equal(parsed.empresa_id, 'empresa-42');
    assert.equal(parsed.stage, 'unit');
    assert.equal(typeof parsed.ts, 'string');
  });

  it('não vaza contexto entre execuções concorrentes', async () => {
    const read = (id: string) =>
      runWithObservability({ requestId: id }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return currentRequestId();
      });

    const [a, b] = await Promise.all([read('req-a'), read('req-b')]);
    assert.equal(a, 'req-a');
    assert.equal(b, 'req-b');
  });

  it('sem contexto ativo, os campos de correlação são nulos', () => {
    const record = logEvent('info', 'orphan_event');
    assert.equal(record.request_id, null);
    assert.equal(record.empresa_id, null);
  });

  it('redige campos e valores sensíveis', () => {
    const fields = sanitizeFields({
      authorization: 'Bearer abc.def.ghi',
      message: 'conteúdo do cliente',
      email: 'cliente@exemplo.com',
      idempotency_key: '11111111-2222-3333-4444-555555555555',
      detail: 'falhou com Bearer tok_123 e eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefgh',
      status: 500,
      nested: { api_key: 'sk_test_12345678', ok: 1 },
    });

    assert.equal(fields.authorization, '[redacted]');
    assert.equal(fields.message, '[redacted]');
    assert.equal(fields.email, '[redacted]');
    assert.equal(fields.idempotency_key, '[redacted]');
    assert.equal(fields.status, 500);
    assert.match(String(fields.detail), /\[redacted\]/);
    assert.doesNotMatch(String(fields.detail), /Bearer tok_123/);
    assert.doesNotMatch(String(fields.detail), /eyJhbGciOiJIUzI1NiJ9/);
    const nested = fields.nested as Record<string, unknown>;
    assert.equal(nested.api_key, '[redacted]');
    assert.equal(nested.ok, 1);
  });

  it('scrubString limita tamanho e remove controle', () => {
    const long = scrubString('x'.repeat(500), 40);
    assert.equal(long.length, 41); // 40 + reticências
    assert.equal(scrubString('a\u0000b\nc'), 'a b c');
  });

  it('falha do sink nunca propaga exceção', () => {
    setObservabilitySink(() => {
      throw new Error('sink indisponível');
    });
    assert.doesNotThrow(() => logEvent('error', 'never_throws'));
  });
});

describe('observabilidade — contadores', () => {
  beforeEach(() => {
    resetCounters();
  });

  it('acumula contadores válidos e ignora nomes inválidos', () => {
    incCounter('dot_chat_received');
    incCounter('dot_chat_received', 2);
    incCounter('nome inválido');
    incCounter('');
    assert.deepEqual(getCounters(), { dot_chat_received: 3 });
  });

  it('recordHttp alimenta contadores de erro por classe', () => {
    recordHttp('GET', '/api/live', 200, 4);
    recordHttp('POST', '/api/dot/chat', 503, 9);
    recordHttp('DELETE', '/api/empresa/abc', 404, 2);

    const counters = getCounters();
    assert.equal(counters.http_requests_total, 3);
    assert.equal(counters.http_5xx_total, 1);
    assert.equal(counters.http_4xx_total, 1);
  });
});
