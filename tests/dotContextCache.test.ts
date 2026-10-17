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

const contextTest = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !sqliteAvailable }, fn);

import { initDB, getDb } from '../lib/db.js';
import {
  buildCachedDotAnswer,
  getDotResponseCache,
  loadDotContextForMessage,
  loadDotRealContext,
  putDotResponseCache,
} from '../services/dotContext.js';

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = '/tmp/filtra-dot-context-cache-test.sqlite';

let ready = false;

async function setup() {
  if (ready) return;
  await initDB();
  const columns = await getDb().all('PRAGMA table_info(reviews)');
  if (!(columns || []).some((column: { name?: string }) => column.name === 'is_test')) {
    throw new Error('initDB deve garantir reviews.is_test (correção A2)');
  }
  ready = true;
}

async function reset() {
  await setup();
  const db = getDb();
  try {
    await db.run('DELETE FROM dot_response_cache');
  } catch {
    /* tabela criada sob demanda */
  }
  await db.run('DELETE FROM reviews');
  await db.run('DELETE FROM empresas');
}

async function seedEmpresa(empresaId: string) {
  const now = new Date().toISOString();
  await getDb().run(
    'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
    [empresaId, 'cnpj-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14), 'Empresa Contexto', 'slug-' + empresaId.slice(0, 8), 'ativo', 'rei', now, now],
  );
}

async function seedReview(empresaId: string, rating: number, tags: string[], replied = false) {
  await getDb().run(
    'INSERT INTO reviews (empresa_id,name,rating,comment,ai_reply,ai_tags,is_test,createdAt) VALUES (?,?,?,?,?,?,0,?)',
    [empresaId, 'Cliente', rating, 'Comentário de teste', replied ? 'Obrigado pelo retorno.' : null, JSON.stringify(tags), new Date().toISOString()],
  );
}

contextTest('Contexto do Dot: snapshot, fingerprint e resposta factual determinística', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  await seedEmpresa(empresa);
  await seedReview(empresa, 5, ['atendimento'], true);
  await seedReview(empresa, 4, ['atendimento'], true);
  await seedReview(empresa, 2, ['tempo de espera'], false);
  await seedReview(empresa, 1, ['tempo de espera'], false);

  const factual = await loadDotContextForMessage(empresa, 'Qual a média das avaliações?');
  assert.equal(factual.cacheHit, true);
  assert.equal(factual.decision.mode, 'cached');
  assert.equal(factual.snapshot.total, 4);
  assert.equal(factual.snapshot.average, 3);
  assert.equal(factual.snapshot.positive, 2);
  assert.equal(factual.snapshot.critical, 2);
  assert.equal(factual.snapshot.pending, 2);
  assert.ok(factual.fingerprint.length > 0);

  // O fingerprint representa os dados: estável enquanto nada muda.
  const again = await loadDotContextForMessage(empresa, 'Qual a média das avaliações?');
  assert.equal(again.fingerprint, factual.fingerprint);

  // Perguntas de raciocínio nunca saem do cache factual.
  const reasoning = await loadDotContextForMessage(empresa, 'Por que a nota caiu e o que fazer?');
  assert.equal(reasoning.cacheHit, false);
  assert.equal(reasoning.decision.mode, 'refresh');
  assert.equal(reasoning.decision.reasoningRequired, true);

  // Respostas factuais usam apenas dados verificados do snapshot.
  const answer = buildCachedDotAnswer('Qual a média das avaliações?', factual.snapshot);
  assert.ok(answer);
  assert.match(String(answer), /3\/5/);
  assert.match(String(answer), /4 avaliações reais/);

  const criticalAnswer = buildCachedDotAnswer('Quantas avaliações críticas temos?', factual.snapshot);
  assert.match(String(criticalAnswer), /2 de 4/);

  const themesAnswer = buildCachedDotAnswer('Quais os principais temas?', factual.snapshot);
  assert.match(String(themesAnswer), /tempo de espera/);

  assert.equal(buildCachedDotAnswer('Por que a nota caiu?', factual.snapshot), null);
  assert.equal(buildCachedDotAnswer('Qual a média?', null), null);

  // Dados novos mudam o fingerprint e invalidam o cache anterior.
  await seedReview(empresa, 5, ['atendimento'], true);
  const afterNewReview = await loadDotContextForMessage(empresa, 'Qual a média das avaliações?');
  assert.notEqual(afterNewReview.fingerprint, factual.fingerprint);
  assert.equal(afterNewReview.snapshot.total, 5);

  // O contexto textual continua disponível para o modelo.
  const context = await loadDotRealContext(empresa);
  assert.match(context, /CONTEXTO REAL DA EMPRESA AUTENTICADA/);
  assert.match(context, /Empresa Contexto/);
});

contextTest('Contexto do Dot: cache de respostas só reutiliza com os mesmos dados', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  await seedEmpresa(empresa);
  await seedReview(empresa, 4, ['atendimento'], true);

  const context = await loadDotContextForMessage(empresa, 'Por que a nota oscila?');
  const fingerprint = context.fingerprint;

  // Sem resposta guardada.
  assert.equal(await getDotResponseCache(empresa, 'Por que a nota oscila?', fingerprint), null);

  await putDotResponseCache(empresa, 'Por que a nota oscila?', fingerprint, 'Resposta analisada pelo Dot.', {
    tokens_used: 321,
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
  });

  const hit = await getDotResponseCache(empresa, 'Por que a nota oscila?', fingerprint);
  assert.ok(hit);
  assert.equal(hit.answer, 'Resposta analisada pelo Dot.');
  assert.equal(hit.tokens_used, 321);
  assert.equal(hit.provider, 'groq');
  assert.equal(hit.model, 'llama-3.3-70b-versatile');
  assert.ok(hit.cache_key.includes(fingerprint));

  // Perguntas equivalentes (mesma normalização) reaproveitam a resposta.
  const paraphrased = await getDotResponseCache(empresa, 'por que a nota oscila', fingerprint);
  assert.ok(paraphrased);

  // Dados diferentes (fingerprint novo) não reaproveitam.
  assert.equal(await getDotResponseCache(empresa, 'Por que a nota oscila?', 'fingerprint-antigo'), null);

  // Outra empresa nunca reaproveita resposta alheia.
  const outra = crypto.randomUUID();
  assert.equal(await getDotResponseCache(outra, 'Por que a nota oscila?', fingerprint), null);

  // Regravar a mesma chave atualiza em vez de duplicar.
  await putDotResponseCache(empresa, 'Por que a nota oscila?', fingerprint, 'Resposta atualizada.', {
    tokens_used: 100,
    provider: 'gemini',
    model: 'gemini-2.0-flash',
  });
  const updated = await getDotResponseCache(empresa, 'Por que a nota oscila?', fingerprint);
  assert.equal(updated?.answer, 'Resposta atualizada.');
  assert.equal(updated?.tokens_used, 100);

  const rows = await getDb().get('SELECT COUNT(*) AS total FROM dot_response_cache WHERE empresa_id = ?', [empresa]);
  assert.equal(Number(rows?.total), 1);
});
