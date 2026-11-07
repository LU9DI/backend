/**
 * Upgrade de banco PRÉ-EXISTENTE para o ledger novo.
 *
 * Bancos criados antes deste ciclo têm `dot_budget_reservations` SEM a coluna
 * `sent_at` e `ai_usage` SEM `tokens_input`/`tokens_output`. A cadeia de boot
 * (`initDB()` → `runCentralMigrations` → `ensureDotLedgerSchema`) precisa
 * adicionar as colunas sem recriar tabelas nem perder linhas. Caso contrário
 * o sweep/mark quebraria em produção — falha fechada, nunca silenciosa.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, after, describe, test } from 'node:test';

let sqliteAvailable = true;
let sqlite3: any;
let open: any;
try {
  sqlite3 = (await import('sqlite3')).default;
  open = (await import('sqlite')).open;
} catch {
  sqliteAvailable = false;
}

const scratchDb = path.join(os.tmpdir(), `filtra-dot-migration-${Date.now()}-${process.pid}.sqlite`);

// O banco "antigo" é criado ANTES de qualquer import do código da aplicação.
if (sqliteAvailable) {
  const legacy = await open({ filename: scratchDb, driver: sqlite3.Database });
  await legacy.exec(`CREATE TABLE dot_budget_reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id TEXT NOT NULL,
    feature TEXT NOT NULL DEFAULT 'dot',
    plan TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    tokens_reserved INTEGER NOT NULL DEFAULT 0,
    tokens_real INTEGER,
    tokens_estimated INTEGER,
    provider TEXT,
    ambiguous INTEGER NOT NULL DEFAULT 0,
    ambiguous_reason TEXT,
    ai_usage_id INTEGER,
    execution_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    settled_at TEXT
  )`);
  await legacy.exec(`CREATE UNIQUE INDEX ux_dot_budget_reservations_ai_usage ON dot_budget_reservations(ai_usage_id) WHERE ai_usage_id IS NOT NULL`);
  await legacy.exec(`CREATE TABLE ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id TEXT,
    tipo TEXT NOT NULL,
    tokens INTEGER NOT NULL DEFAULT 0,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    provider TEXT,
    feature TEXT
  )`);
  const now = new Date().toISOString();
  await legacy.run(
    `INSERT INTO dot_budget_reservations
       (empresa_id, feature, plan, status, tokens_reserved, ambiguous, created_at, updated_at, expires_at)
     VALUES ('empresa-legacy', 'dot', 'rei', 'pending', 1800, 0, ?, ?, ?)`,
    [now, now, new Date(Date.now() + 60_000).toISOString()],
  );
  await legacy.run(
    `INSERT INTO ai_usage (empresa_id, tipo, tokens, provider, feature) VALUES ('empresa-legacy', 'filtra_dot_chat', 321, 'groq', 'dot')`,
  );
  await legacy.close();
}

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = scratchDb;

const suite = sqliteAvailable ? describe : describe.skip;

suite('Upgrade de banco legado — colunas novas', () => {
  before(async () => {
    assert.ok(sqliteAvailable, 'sqlite não disponível');
  });

  after(async () => {
    try {
      const { closeDB } = await import('../lib/db.js');
      await closeDB();
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(scratchDb);
    } catch {
      /* ok */
    }
  });

  test('initDB adiciona sent_at e tokens in/out sem perder linhas', async () => {
    const { initDB, getDb } = await import('../lib/db.js');
    await initDB();
    const db = getDb();

    const reservationCols = await db.all('PRAGMA table_info(dot_budget_reservations)');
    const names = new Set(reservationCols.map((c: any) => String(c.name)));
    assert.ok(names.has('sent_at'), 'sent_at deve ser adicionado pelo upgrade');

    const usageCols = await db.all('PRAGMA table_info(ai_usage)');
    const usageNames = new Set(usageCols.map((c: any) => String(c.name)));
    assert.ok(usageNames.has('tokens_input'), 'ai_usage.tokens_input ausente após upgrade');
    assert.ok(usageNames.has('tokens_output'), 'ai_usage.tokens_output ausente após upgrade');

    // A linha legada continua legível e o ledger a enxerga.
    const row = await db.get('SELECT id, status, tokens_reserved FROM dot_budget_reservations WHERE empresa_id = ?', ['empresa-legacy']);
    assert.ok(row, 'a reserva legada não pode sumir');
    assert.equal(String(row.status), 'pending');

    const ledger = await import('../services/dotLedger.js');
    const marked = await ledger.markDotReservationSent({ empresaId: 'empresa-legacy', reservationId: Number(row.id) });
    assert.equal(marked.ok, true);
    assert.ok(marked.reservation?.sent_at, 'mark funciona sobre a reserva migrada');

    const usage = await db.get("SELECT COUNT(*) AS c FROM ai_usage WHERE empresa_id = 'empresa-legacy'");
    assert.equal(Number(usage?.c || 0), 1);
  });
});
