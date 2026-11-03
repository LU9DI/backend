/**
 * Atomicidade real da execução interna do Dot (SQLite).
 *
 * Prova que claim, auditoria inicial, caso interno, follow-up, status final e
 * auditoria final vivem na MESMA transação: qualquer falha reverte tudo e a
 * ação continua `approved` (retentável), sem registrar sucesso.
 *
 * A contraprova em PostgreSQL fica em `dotExecutionAtomicity.pg.test.ts`.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

let sqliteAvailable = true;
try {
  await import('sqlite3');
  await import('sqlite');
} catch {
  sqliteAvailable = false;
}

const runTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !sqliteAvailable }, fn);

process.env.NODE_ENV = 'test';
const dbPath = path.join(os.tmpdir(), `filtra-dot-exec-atomicity-${Date.now()}.sqlite`);
process.env.SQLITE_DB_PATH = dbPath;
delete process.env.DATABASE_URL;

import { closeDB, getDb, initDB } from '../lib/db.js';
import { executeDotAction } from '../services/dotActionQueue.js';
import { DotActorIdentityError, dotInternalActor, dotUserActor } from '../services/dotActor.js';
import { ensureDotAccessSchema } from '../services/dotAccessControl.js';

let ready = false;

async function setup() {
  if (ready) return;
  await initDB();
  const db = getDb();
  // `dot_decisions` ainda é específica do Dot e não faz parte das migrações
  // centrais deste PR; o schema de teste é criado aqui, nunca em produção.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS dot_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      priority TEXT NOT NULL,
      severity TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      options_json TEXT NOT NULL,
      requires_approval INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    )
  `);
  await ensureDotAccessSchema();
  ready = true;
}

async function seedApprovedAction(empresaId: string) {
  const db = getDb();
  const decision = await db.run(
    `INSERT INTO dot_decisions
      (empresa_id,event_id,type,priority,severity,reason,evidence_json,recommendation,options_json,requires_approval,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [empresaId, Date.now() % 2_000_000_000, 'crise_reputacional', 'high', 'critical', 'teste de atomicidade', '[]', 'teste', '[]', 1, 'approved', new Date().toISOString()],
  );
  const decisionId = Number(decision.lastID);
  const action = await db.run(
    `INSERT INTO dot_action_queue
      (empresa_id,decision_id,option_id,action,status,approved_at,created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [empresaId, decisionId, 'opcao_1', 'priorizar_e_resolver', 'approved', new Date().toISOString(), new Date().toISOString()],
  );
  await db.run(
    `INSERT INTO dot_agent_permissions
      (empresa_id,user_id,resource,action,granted,granted_by,granted_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT DO NOTHING`,
    [empresaId, null, 'operations', 'execute', 1, 'test', new Date().toISOString(), new Date().toISOString(), new Date().toISOString()],
  );
  return { decisionId, actionId: Number(action.lastID) };
}

runTest('execução feliz grava caso, follow-up, status e auditoria no mesmo commit', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const { actionId } = await seedApprovedAction(empresa);
  const result = await executeDotAction(empresa, actionId, dotUserActor('owner-test'));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'executed');

  const db = getDb();
  const action = await db.get('SELECT status FROM dot_action_queue WHERE empresa_id=? AND id=?', [empresa, actionId]);
  assert.equal(action.status, 'executed');
  const cases = await db.all('SELECT id FROM dot_internal_cases WHERE empresa_id=? AND action_id=?', [empresa, actionId]);
  assert.equal(cases.length, 1);
  const followups = await db.all('SELECT id FROM dot_followups WHERE empresa_id=? AND action_id=?', [empresa, actionId]);
  assert.equal(followups.length, 1);
  const events = await db.all(
    "SELECT event, actor_type, actor_id FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event IN ('execution_started','executed') ORDER BY id",
    [empresa, actionId],
  );
  assert.deepEqual(events.map((row: any) => row.event), ['execution_started', 'executed']);
  for (const row of events) {
    assert.equal(String(row.actor_type), 'user', 'ator efetivo deve ser auditado como usuário');
    assert.equal(String(row.actor_id), 'owner-test', 'actor_id deve ser o usuário autenticado efetivo');
  }
});

runTest('falha ao criar follow-up reverte caso, claim e auditoria inicial', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const { actionId } = await seedApprovedAction(empresa);
  const db = getDb();
  await db.exec(`
    CREATE TRIGGER fail_followup BEFORE INSERT ON dot_followups
    BEGIN
      SELECT RAISE(ABORT, 'follow-up insert failed');
    END;
  `);
  try {
    const result = await executeDotAction(empresa, actionId, dotUserActor('owner-test'));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'approved');

    const action = await db.get('SELECT status FROM dot_action_queue WHERE empresa_id=? AND id=?', [empresa, actionId]);
    assert.equal(action.status, 'approved', 'rollback deve preservar approved');
    const cases = await db.all('SELECT id FROM dot_internal_cases WHERE empresa_id=? AND action_id=?', [empresa, actionId]);
    assert.equal(cases.length, 0, 'caso interno não pode sobreviver ao rollback');
    const followups = await db.all('SELECT id FROM dot_followups WHERE empresa_id=? AND action_id=?', [empresa, actionId]);
    assert.equal(followups.length, 0, 'follow-up não pode sobreviver ao rollback');
    const started = await db.all("SELECT id FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='execution_started'", [empresa, actionId]);
    assert.equal(started.length, 0, 'auditoria inicial deve ser revertida');
    const executed = await db.all("SELECT id FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='executed'", [empresa, actionId]);
    assert.equal(executed.length, 0, 'nunca registrar sucesso após falha');
    const failed = await db.all("SELECT actor_type, actor_id, metadata FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='failed'", [empresa, actionId]);
    assert.equal(failed.length, 1, 'falha deve ser auditada fora da transação');
    assert.equal(String(failed[0].actor_type), 'user', 'failed deve registrar o ator efetivo');
    assert.equal(String(failed[0].actor_id), 'owner-test');
    const metadata = JSON.parse(String(failed[0].metadata));
    assert.equal(metadata.rolled_back, true);
    assert.equal(metadata.phase, 'follow_up');
  } finally {
    await db.exec('DROP TRIGGER IF EXISTS fail_followup');
  }

  // Recuperação: removida a falha forçada, a MESMA ação executa.
  const retry = await executeDotAction(empresa, actionId, dotUserActor('owner-test'));
  assert.equal(retry.ok, true, JSON.stringify(retry));
  const action = await db.get('SELECT status FROM dot_action_queue WHERE empresa_id=? AND id=?', [empresa, actionId]);
  assert.equal(action.status, 'executed');
});

runTest('duas execuções concorrentes da mesma ação produzem um único efeito', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const { actionId } = await seedApprovedAction(empresa);
  const results = await Promise.all([
    executeDotAction(empresa, actionId, dotUserActor('owner-a')),
    executeDotAction(empresa, actionId, dotUserActor('owner-b')),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
  const db = getDb();
  const cases = await db.all('SELECT id FROM dot_internal_cases WHERE empresa_id=? AND action_id=?', [empresa, actionId]);
  assert.equal(cases.length, 1);
  const followups = await db.all('SELECT id FROM dot_followups WHERE empresa_id=? AND action_id=?', [empresa, actionId]);
  assert.equal(followups.length, 1);
  const executed = await db.all("SELECT id FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='executed'", [empresa, actionId]);
  assert.equal(executed.length, 1);

  // Replay depois do commit também não duplica.
  const replay = await executeDotAction(empresa, actionId, dotUserActor('owner-c'));
  assert.equal(replay.ok, false);
  const casesAfter = await db.all('SELECT id FROM dot_internal_cases WHERE empresa_id=? AND action_id=?', [empresa, actionId]);
  assert.equal(casesAfter.length, 1);
});

runTest('ator interno explícito é auditado como dot, sem usuário anônimo', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const { actionId } = await seedApprovedAction(empresa);
  const result = await executeDotAction(empresa, actionId, dotInternalActor('scheduler'));
  assert.equal(result.ok, true, JSON.stringify(result));

  const db = getDb();
  const rows = await db.all(
    "SELECT event, actor_type, actor_id, metadata FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event IN ('execution_started','executed') ORDER BY id",
    [empresa, actionId],
  );
  assert.deepEqual(rows.map((row: any) => row.event), ['execution_started', 'executed']);
  for (const row of rows) {
    assert.equal(String(row.actor_type), 'dot');
    assert.equal(row.actor_id, null, 'ator interno nunca registra usuário anônimo');
    assert.equal(JSON.parse(String(row.metadata)).actor_source, 'scheduler');
  }
});

runTest('falha com ator interno audita failed como dot e não mascara a exceção', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const { actionId } = await seedApprovedAction(empresa);
  const db = getDb();
  await db.exec(`
    CREATE TRIGGER fail_followup_internal BEFORE INSERT ON dot_followups
    BEGIN
      SELECT RAISE(ABORT, 'internal follow-up failure');
    END;
  `);
  try {
    const result = await executeDotAction(empresa, actionId, dotInternalActor('monitor'));
    assert.equal(result.ok, false);
    assert.match(String(result.reason), /internal follow-up failure/i, 'exceção original não pode ser mascarada');

    const failed: any = await db.get(
      "SELECT actor_type, actor_id, metadata FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='failed'",
      [empresa, actionId],
    );
    assert.equal(String(failed.actor_type), 'dot');
    assert.equal(failed.actor_id, null);
    const metadata = JSON.parse(String(failed.metadata));
    assert.equal(metadata.rolled_back, true);
    assert.equal(metadata.actor_source, 'monitor');
    const action: any = await db.get('SELECT status FROM dot_action_queue WHERE empresa_id=? AND id=?', [empresa, actionId]);
    assert.equal(action.status, 'approved', 'rollback preserva a ação aprovada');
  } finally {
    await db.exec('DROP TRIGGER IF EXISTS fail_followup_internal');
  }
});

runTest('identidade ausente é rejeitada sem efeito e a ação continua executável', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const { actionId } = await seedApprovedAction(empresa);

  await assert.rejects(
    () => executeDotAction(empresa, actionId, undefined),
    (error: any) => error instanceof DotActorIdentityError && error.code === 'DOT_ACTOR_IDENTITY_REQUIRED',
  );

  const db = getDb();
  const action: any = await db.get('SELECT status FROM dot_action_queue WHERE empresa_id=? AND id=?', [empresa, actionId]);
  assert.equal(action.status, 'approved');
  const audits = await db.all('SELECT id FROM dot_action_audit WHERE empresa_id=? AND action_id=?', [empresa, actionId]);
  assert.equal(audits.length, 0, 'rejeição de identidade não pode gravar auditoria');

  const retry = await executeDotAction(empresa, actionId, dotUserActor('owner-test'));
  assert.equal(retry.ok, true, JSON.stringify(retry));
});

runTest('limpeza', async () => {
  await closeDB();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      /* best effort */
    }
  }
});
