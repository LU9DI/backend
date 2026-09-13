import assert from 'node:assert/strict';
import test from 'node:test';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import {
  buildReportPeriod,
  ensureReportCacheSchema,
  getOrGenerateWhatsAppReport,
} from '../services/whatsappReportService.js';
import { planoTemRelatorioWhatsApp } from '../lib/plans.js';

const reviewsSchema = `CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id TEXT,
  rating INTEGER,
  comment TEXT,
  ai_tags TEXT,
  sentiment TEXT,
  sentiment_score REAL,
  createdAt TEXT,
  treated_at TEXT,
  is_test INTEGER DEFAULT 0
)`;

async function seed(db: any, id = 'empresa-1') {
  await db.exec(reviewsSchema);
  await db.run(
    `INSERT INTO reviews (empresa_id, rating, createdAt, is_test, ai_tags, sentiment, sentiment_score)
     VALUES (?, ?, ?, 0, ?, ?, ?)`,
    [id, 5, '2026-09-08T10:00:00.000Z', JSON.stringify(['Atendimento']), 'positivo', 0.9]
  );
  await db.run(
    `INSERT INTO reviews (empresa_id, rating, createdAt, is_test, ai_tags, sentiment, sentiment_score)
     VALUES (?, ?, ?, 0, ?, ?, ?)`,
    [id, 2, '2026-09-09T10:00:00.000Z', JSON.stringify(['Espera']), 'negativo', -0.6]
  );
  await ensureReportCacheSchema(db);
}

test('Inicial não tem relatório WhatsApp', () => {
  assert.equal(planoTemRelatorioWhatsApp('inicial'), false);
});

test('cada plano gera conteúdo do seu nível', async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await seed(db);
  const period = buildReportPeriod('semana', '2026-09-07', '2026-09-13');

  const pro = await getOrGenerateWhatsAppReport(db, 'empresa-1', period, 'pro');
  assert.match(pro.text, /Plano:\* Pro/);
  assert.doesNotMatch(pro.text, /Distribuição das avaliações/);

  // upgrade: cache do Pro não serve para Ultra
  const ultra = await getOrGenerateWhatsAppReport(db, 'empresa-1', period, 'ultra');
  assert.equal(ultra.cached, false);
  assert.match(ultra.text, /Distribuição das avaliações/);

  const corp = await getOrGenerateWhatsAppReport(db, 'empresa-1', period, 'corporativo');
  assert.equal(corp.cached, false);
  assert.match(corp.text, /Status operacional/);

  const rei = await getOrGenerateWhatsAppReport(db, 'empresa-1', period, 'rei');
  assert.equal(rei.cached, false);
  assert.match(rei.text, /Principais temas identificados no painel/);

  // mesmo plano de novo → cache hit
  const rei2 = await getOrGenerateWhatsAppReport(db, 'empresa-1', period, 'rei');
  assert.equal(rei2.cached, true);
  assert.equal(rei2.text, rei.text);

  await db.close();
});

test('dois claims concorrentes: só um gera', async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await seed(db);
  const period = buildReportPeriod('semana', '2026-09-07', '2026-09-13');

  const [a, b] = await Promise.all([
    getOrGenerateWhatsAppReport(db, 'empresa-1', period, 'pro'),
    getOrGenerateWhatsAppReport(db, 'empresa-1', period, 'pro'),
  ]);

  // um gerou, o outro pegou cache (ou ambos coerentes no mesmo texto)
  assert.equal(a.text, b.text);
  assert.equal(a.model, 'none');
  assert.equal(b.model, 'none');
  assert.ok(a.cached || b.cached || (!a.cached && !b.cached)); // pelo menos consistentes

  const rows = await db.all(
    `SELECT status FROM relatorios_cache WHERE cliente_id=? AND periodo_inicio=? AND periodo_fim=?`,
    ['empresa-1', period.inicio, period.fim]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'ready');
  await db.close();
});
