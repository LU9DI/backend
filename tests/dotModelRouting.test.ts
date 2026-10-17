import assert from 'node:assert/strict';
import { test } from 'node:test';

import { modelSupportsProvider } from '../groqService.js';
import { selectDotModel } from '../services/dotModelRouting.js';

process.env.NODE_ENV = 'test';
// Sem chaves configuradas o provedor primário é determinístico ('groq').
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;

test('Roteamento de modelo: tiers refletem a intenção da mensagem', () => {
  assert.equal(selectDotModel('Por que a nota média caiu nos últimos dias?').tier, 'deep');
  assert.equal(selectDotModel('Compare o desempenho deste mês com o anterior').tier, 'deep');
  assert.equal(selectDotModel('Qual a média das avaliações?').tier, 'fast');
  assert.equal(selectDotModel('Quantas avaliações temos?').tier, 'fast');
  assert.equal(selectDotModel('Bom dia').tier, 'standard');
});

test('Roteamento de modelo: o modelo devolvido é válido para o provedor informado', () => {
  for (const message of ['Por que a nota caiu?', 'Qual a média?', 'Olá']) {
    const routing = selectDotModel(message);
    assert.ok(routing.model.length > 0);
    assert.equal(
      modelSupportsProvider(routing.provider, routing.model),
      true,
      `modelo ${routing.model} não pertence ao provedor ${routing.provider}`,
    );
    assert.ok(routing.reason.length > 0);
  }
});

test('Roteamento de modelo: configuração por ambiente só aceita modelo do provedor correto', () => {
  const original = { deep: process.env.DOT_MODEL_DEEP, all: process.env.DOT_MODEL };

  try {
    process.env.DOT_MODEL_DEEP = 'llama-3.3-70b-versatile';
    assert.equal(selectDotModel('Por que a nota caiu?').model, 'llama-3.3-70b-versatile');

    // Um modelo de outro provedor é recusado em vez de ser anunciado como escolha.
    process.env.DOT_MODEL_DEEP = 'gemini-2.0-flash';
    const fallback = selectDotModel('Por que a nota caiu?');
    assert.notEqual(fallback.model, 'gemini-2.0-flash');
    assert.equal(modelSupportsProvider(fallback.provider, fallback.model), true);

    delete process.env.DOT_MODEL_DEEP;
    process.env.DOT_MODEL = 'llama-3.1-8b-instant';
    assert.equal(selectDotModel('Bom dia').model, 'llama-3.1-8b-instant');
  } finally {
    if (original.deep === undefined) delete process.env.DOT_MODEL_DEEP;
    else process.env.DOT_MODEL_DEEP = original.deep;
    if (original.all === undefined) delete process.env.DOT_MODEL;
    else process.env.DOT_MODEL = original.all;
  }
});

test('Roteamento de modelo: compatibilidade de modelo por provedor', () => {
  assert.equal(modelSupportsProvider('groq', 'llama-3.3-70b-versatile'), true);
  assert.equal(modelSupportsProvider('groq', 'mixtral-8x7b-32768'), true);
  assert.equal(modelSupportsProvider('groq', 'gemini-2.0-flash'), false);
  assert.equal(modelSupportsProvider('gemini', 'gemini-2.0-flash'), true);
  assert.equal(modelSupportsProvider('gemini', 'llama-3.3-70b-versatile'), false);
  assert.equal(modelSupportsProvider('groq', ''), false);
  assert.equal(modelSupportsProvider('gemini', '   '), false);
});
