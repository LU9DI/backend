import assert from 'node:assert/strict';
import test from 'node:test';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { buildReportPeriod, ensureReportCacheSchema, getOrGenerateWhatsAppReport } from '../services/whatsappReportService.js';
import { planoTemRelatorioWhatsApp } from '../lib/plans.js';

const reviewsSchema = `CREATE TABLE reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id TEXT, rating INTEGER, comment TEXT, ai_tags TEXT, sentiment TEXT, sentiment_score REAL, createdAt TEXT, treated_at TEXT, is_test INTEGER DEFAULT 0)`;

test('report period uses deterministic start/end key', () => {
  const p = buildReportPeriod('semana', '2026-09-07', '2026-09-13');
  assert.equal(p.inicio, '2026-09-07');
  assert.equal(p.fim, '2026-09-13');
  assert.equal(p.chave, '2026-09-07_2026-09-13');
});

test('report eligibility starts at Pro and Trial equals Rei', () => {
  assert.equal(planoTemRelatorioWhatsApp('inicial'), false);
  assert.equal(planoTemRelatorioWhatsApp('pro'), true);
  assert.equal(planoTemRelatorioWhatsApp('ultra'), true);
  assert.equal(planoTemRelatorioWhatsApp('corporativo'), true);
  assert.equal(planoTemRelatorioWhatsApp('rei'), true);
  assert.equal(planoTemRelatorioWhatsApp('trial'), true);
  assert.equal(planoTemRelatorioWhatsApp('teste'), true);
});

test('report cache schema enforces one report per client and period', async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await ensureReportCacheSchema(db);
  await db.run(`INSERT INTO relatorios_cache (id, cliente_id, periodo_tipo, periodo_inicio, periodo_fim, chave_periodo, status, texto_relatorio) VALUES (?, ?, ?, ?, ?, ?, 'ready', ?)`, ['a', 'empresa-1', 'semana', '2026-09-07', '2026-09-13', '2026-09-07_2026-09-13', 'teste']);
  await assert.rejects(db.run(`INSERT INTO relatorios_cache (id, cliente_id, periodo_tipo, periodo_inicio, periodo_fim, chave_periodo, status, texto_relatorio) VALUES (?, ?, ?, ?, ?, ?, 'ready', ?)`, ['b', 'empresa-1', 'semana', '2026-09-07', '2026-09-13', '2026-09-07_2026-09-13', 'duplicado']));
  await db.close();
});

test('Pro is the basic tier and adapts highlights to the establishment data', async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(reviewsSchema);
  await db.run(`INSERT INTO reviews (empresa_id, rating, createdAt, is_test, ai_tags, sentiment) VALUES (?, ?, ?, 0, ?, ?)`, ['empresa-1', 5, '2026-09-08T10:00:00.000Z', JSON.stringify(['Atendimento', 'Rapidez']), 'positivo']);
  await db.run(`INSERT INTO reviews (empresa_id, rating, createdAt, is_test, ai_tags, sentiment) VALUES (?, ?, ?, 0, ?, ?)`, ['empresa-1', 2, '2026-09-09T10:00:00.000Z', JSON.stringify(['Tempo de espera']), 'negativo']);
  await ensureReportCacheSchema(db);
  const result = await getOrGenerateWhatsAppReport(db, 'empresa-1', buildReportPeriod('semana', '2026-09-07', '2026-09-13'), 'pro');
  assert.equal(result.cached, false);
  assert.equal(result.model, 'none');
  assert.equal(result.data.score_medio, 3.5);
  assert.equal(result.data.total_avaliacoes, 2);
  assert.equal(result.data.estrelas['5'], 1);
  assert.equal(result.data.estrelas['2'], 1);
  assert.deepEqual(result.data.top_elogios, [{ tag: 'Atendimento', count: 1 }, { tag: 'Rapidez', count: 1 }]);
  assert.deepEqual(result.data.top_alertas, [{ tag: 'Tempo de espera', count: 1 }]);
  assert.match(result.text, /3,5\/5/);
  assert.match(result.text, /Destaques da semana/);
  assert.match(result.text, /Atendimento/);
  assert.match(result.text, /Tempo de espera/);
  assert.match(result.text, /50% positivo/);
  assert.doesNotMatch(result.text, /Distribuição das avaliações|Score médio de sentimento|Crises nas últimas 24h/i);
  assert.doesNotMatch(result.text, /recomenda-se|preservar|acompanhar os pontos|provavelmente|crescimento|projeção/i);
  await db.close();
});

test('Rei uses richer panel data without generating interpretations', async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(reviewsSchema);
  await db.run(`INSERT INTO reviews (empresa_id, rating, createdAt, is_test, ai_tags, sentiment, sentiment_score) VALUES (?, ?, ?, 0, ?, ?, ?)`, ['empresa-1', 5, '2026-09-08T10:00:00.000Z', JSON.stringify(['Atendimento', 'Rapidez']), 'positivo', 0.9]);
  await db.run(`INSERT INTO reviews (empresa_id, rating, createdAt, is_test, ai_tags, sentiment, sentiment_score) VALUES (?, ?, ?, 0, ?, ?, ?)`, ['empresa-1', 2, '2026-09-09T10:00:00.000Z', JSON.stringify(['Tempo de espera']), 'negativo', -0.7]);
  await ensureReportCacheSchema(db);
  const result = await getOrGenerateWhatsAppReport(db, 'empresa-1', buildReportPeriod('semana', '2026-09-07', '2026-09-13'), 'rei');
  assert.equal(result.cached, false);
  assert.equal(result.model, 'none');
  assert.equal(result.data.score_medio, 3.5);
  assert.equal(result.data.total_avaliacoes, 2);
  assert.match(result.text, /Atendimento/);
  assert.match(result.text, /Tempo de espera/);
  assert.match(result.text, /Distribuição das avaliações/);
  assert.match(result.text, /Principais temas identificados no painel/);
  assert.doesNotMatch(result.text, /recomenda-se|preservar|acompanhar os pontos|provavelmente|crescimento|projeção/i);
  await db.close();
});

test('trial uses the same report tier as rei', async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(reviewsSchema);
  await db.run(`INSERT INTO reviews (empresa_id, rating, createdAt, is_test, ai_tags) VALUES (?, ?, ?, 0, ?)`, ['empresa-rei', 5, '2026-09-08T10:00:00.000Z', JSON.stringify(['Atendimento'])]);
  await db.run(`INSERT INTO reviews (empresa_id, rating, createdAt, is_test, ai_tags) VALUES (?, ?, ?, 0, ?)`, ['empresa-trial', 5, '2026-09-08T10:00:00.000Z', JSON.stringify(['Atendimento'])]);
  const period = buildReportPeriod('semana', '2026-09-07', '2026-09-13');
  const rei = await getOrGenerateWhatsAppReport(db, 'empresa-rei', period, 'rei');
  const trial = await getOrGenerateWhatsAppReport(db, 'empresa-trial', period, 'trial');
  assert.equal(trial.text, rei.text);
  assert.equal(trial.model, 'none');
  assert.equal(rei.model, 'none');
  await db.close();
});

test('cache hit returns stored text without requiring an AI provider', async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(reviewsSchema);
  await db.run(`INSERT INTO reviews (empresa_id, rating, createdAt, is_test) VALUES (?, ?, ?, 0)`, ['empresa-1', 5, '2026-09-08T10:00:00.000Z']);
  await ensureReportCacheSchema(db);
  await db.run(`INSERT INTO relatorios_cache (id, cliente_id, periodo_tipo, periodo_inicio, periodo_fim, chave_periodo, status, texto_relatorio, modelo_ia) VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)`, ['a', 'empresa-1', 'semana', '2026-09-07', '2026-09-13', '2026-09-07_2026-09-13', '📊 *Resumo*', 'none']);
  const result = await getOrGenerateWhatsAppReport(db, 'empresa-1', buildReportPeriod('semana', '2026-09-07', '2026-09-13'));
  assert.equal(result.cached, true);
  assert.equal(result.text, '📊 *Resumo*');
  assert.equal(result.model, 'none');
  await db.close();
});
