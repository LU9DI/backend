import assert from 'node:assert/strict';
import test from 'node:test';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { buildReportPeriod, ensureReportCacheSchema, getOrGenerateWhatsAppReport } from '../services/whatsappReportService.js';

test('report period uses deterministic start/end key', () => {
  const p = buildReportPeriod('semana', '2026-09-07', '2026-09-13');
  assert.equal(p.inicio, '2026-09-07');
  assert.equal(p.fim, '2026-09-13');
  assert.equal(p.chave, '2026-09-07_2026-09-13');
});

test('report cache schema enforces one report per client and period', async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await ensureReportCacheSchema(db);
  await db.run(
    `INSERT INTO relatorios_cache
      (id, cliente_id, periodo_tipo, periodo_inicio, periodo_fim, chave_periodo, status, texto_relatorio)
     VALUES (?, ?, ?, ?, ?, ?, 'ready', ?)`,
    ['a', 'empresa-1', 'semana', '2026-09-07', '2026-09-13', '2026-09-07_2026-09-13', 'teste']
  );
  await assert.rejects(
    db.run(
      `INSERT INTO relatorios_cache
        (id, cliente_id, periodo_tipo, periodo_inicio, periodo_fim, chave_periodo, status, texto_relatorio)
       VALUES (?, ?, ?, ?, ?, ?, 'ready', ?)`,
      ['b', 'empresa-1', 'semana', '2026-09-07', '2026-09-13', '2026-09-07_2026-09-13', 'duplicado']
    )
  );
  await db.close();
});

test('cache hit returns stored text without requiring an AI provider', async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id TEXT, rating INTEGER, comment TEXT, ai_tags TEXT, createdAt TEXT, is_test INTEGER DEFAULT 0)`);
  await db.run(`INSERT INTO reviews (empresa_id, rating, createdAt, is_test) VALUES (?, ?, ?, 0)`, ['empresa-1', 5, '2026-09-08 10:00:00']);
  await ensureReportCacheSchema(db);
  await db.run(
    `INSERT INTO relatorios_cache
      (id, cliente_id, periodo_tipo, periodo_inicio, periodo_fim, chave_periodo, status, texto_relatorio, modelo_ia)
     VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
    ['a', 'empresa-1', 'semana', '2026-09-07', '2026-09-13', '2026-09-07_2026-09-13', '📊 *Resumo*', 'groq:test']
  );

  const result = await getOrGenerateWhatsAppReport(db, 'empresa-1', buildReportPeriod('semana', '2026-09-07', '2026-09-13'));
  assert.equal(result.cached, true);
  assert.equal(result.text, '📊 *Resumo*');
  await db.close();
});
