import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

let sqliteAvailable = true;
try {
  await import('sqlite3');
  await import('sqlite');
} catch {
  sqliteAvailable = false;
}

const quotaTest = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !sqliteAvailable }, fn);

import { initDB, getDb } from '../lib/db.js';
import { recordAiUsage } from '../lib/aiUsage.js';
import {
  FEATURE_TOKEN_LIMITS,
  getFeatureTokenLimit,
  tokensUsadosFeatureMes,
  tokensUsadosMes,
} from '../lib/quota.js';

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = '/tmp/filtra-dot-quota-isolation-test.sqlite';

let ready = false;

async function setup() {
  if (ready) return;
  await initDB();
  await getDb().run('DELETE FROM ai_usage');
  ready = true;
}

quotaTest('Cota por feature: limites declarados apenas para planos com acesso ao Dot', async () => {
  assert.ok(getFeatureTokenLimit('rei', 'dot') > 0);
  assert.ok(getFeatureTokenLimit('corporativo', 'dot') > 0);
  // 'corp' e 'corporate' são aliases de 'corporativo'.
  assert.equal(getFeatureTokenLimit('corp', 'dot'), getFeatureTokenLimit('corporativo', 'dot'));
  assert.equal(getFeatureTokenLimit('corporate', 'dot'), getFeatureTokenLimit('corporativo', 'dot'));
  // Planos sem acesso ao Dot não recebem orçamento.
  assert.equal(getFeatureTokenLimit('trial', 'dot'), 0);
  assert.equal(getFeatureTokenLimit('ultra', 'dot'), 0);
  assert.equal(getFeatureTokenLimit('pro', 'dot'), 0);
  // Feature desconhecida não recebe orçamento.
  assert.equal(getFeatureTokenLimit('rei', 'feature_inexistente'), 0);
  assert.ok(Object.keys(FEATURE_TOKEN_LIMITS).includes('dot'));
});

quotaTest('Cota por feature: consumo do Dot não consome o orçamento de feedback', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const outra = crypto.randomUUID();
  const db = getDb();

  // Consumo do Dot.
  await recordAiUsage(db, { empresaId: empresa, tipo: 'filtra_dot_chat', tokens: 1500, provider: 'groq', feature: 'dot' });
  assert.equal(await tokensUsadosFeatureMes(empresa, 'dot'), 1500);
  assert.equal(await tokensUsadosMes(empresa), 0, 'tokens do Dot não podem entrar no orçamento de feedback');

  // Consumo de feedback (sem feature).
  await recordAiUsage(db, { empresaId: empresa, tipo: 'analise_review', tokens: 400, provider: 'groq' });
  assert.equal(await tokensUsadosMes(empresa), 400);
  assert.equal(await tokensUsadosFeatureMes(empresa, 'dot'), 1500, 'consumo de feedback não pode entrar na cota do Dot');

  // Mais consumo do Dot não altera o feedback.
  await recordAiUsage(db, { empresaId: empresa, tipo: 'filtra_dot_chat', tokens: 500, provider: 'groq', feature: 'dot' });
  assert.equal(await tokensUsadosFeatureMes(empresa, 'dot'), 2000);
  assert.equal(await tokensUsadosMes(empresa), 400);

  // Isolamento entre empresas.
  assert.equal(await tokensUsadosFeatureMes(outra, 'dot'), 0);
  assert.equal(await tokensUsadosMes(outra), 0);
});

quotaTest('Cota por feature: feature normalizada e limitada a tokens positivos', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const db = getDb();

  await recordAiUsage(db, { empresaId: empresa, tipo: 'filtra_dot_chat', tokens: 300, provider: 'groq', feature: 'DOT' });
  assert.equal(await tokensUsadosFeatureMes(empresa, 'dot'), 300);

  // Tokens zerados/negativos não geram linha.
  await recordAiUsage(db, { empresaId: empresa, tipo: 'filtra_dot_chat', tokens: 0, provider: 'groq', feature: 'dot' });
  await recordAiUsage(db, { empresaId: empresa, tipo: 'filtra_dot_chat', tokens: -50, provider: 'groq', feature: 'dot' });
  assert.equal(await tokensUsadosFeatureMes(empresa, 'dot'), 300);

  // Feature vazia nunca é consultada.
  assert.equal(await tokensUsadosFeatureMes(empresa, ''), 0);
  assert.equal(await tokensUsadosFeatureMes('', 'dot'), 0);
});

quotaTest('Cota por feature: leitura indisponível falha fechada (nunca libera tokens)', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const db = getDb();

  await recordAiUsage(db, { empresaId: empresa, tipo: 'filtra_dot_chat', tokens: 100, provider: 'groq', feature: 'dot' });
  assert.equal(await tokensUsadosFeatureMes(empresa, 'dot'), 100);

  // Simula a indisponibilidade da tabela de consumo. Devolver 0 liberaria
  // tokens ilimitados para o DOT exatamente quando o controle está fora do ar.
  await db.run('ALTER TABLE ai_usage RENAME TO ai_usage_offline');
  try {
    await assert.rejects(() => tokensUsadosFeatureMes(empresa, 'dot'));
  } finally {
    await db.run('ALTER TABLE ai_usage_offline RENAME TO ai_usage');
  }

  // Com a leitura restaurada, a cota volta a ser medida normalmente.
  assert.equal(await tokensUsadosFeatureMes(empresa, 'dot'), 100);
});
