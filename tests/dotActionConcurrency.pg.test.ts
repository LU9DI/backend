/**
 * Teste PostgreSQL real: dois processos Node, pools e conexões independentes.
 * Executado isoladamente via npm run test:postgres.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { databaseUrl, parseWorkerJson, runNodeScript } from './helpers/pg-test-utils.js';
import { initDB, getDb, closeDB } from '../lib/db.js';

const PREPARE_WORKER = new URL('./helpers/prepare-dot-action.pg.ts', import.meta.url);
const APPROVE_WORKER = new URL('./helpers/approve-dot-action.pg.ts', import.meta.url);
const WORKER_TIMEOUT_MS = 60_000;

function workerEnv(): NodeJS.ProcessEnv {
  assert.ok(databaseUrl(), 'DATABASE_URL de teste é obrigatória');
  return { DATABASE_URL: databaseUrl() };
}

test('duas instâncias PostgreSQL concorrentes retornam a mesma ação sem auditoria duplicada', async () => {
  assert.ok(databaseUrl(), 'DATABASE_URL de teste é obrigatória');
  process.env.NODE_ENV = 'test';
  await initDB();
  const db = getDb();
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
  const empresaId = `pg-concurrency-${crypto.randomUUID()}`;
  const options = [{ id: 'opcao_pg', title: 'Teste', action: 'priorizar_e_resolver', risk: 'medium' }];
  const seeded = await db.run(
    `INSERT INTO dot_decisions
      (empresa_id,event_id,type,priority,severity,reason,evidence_json,recommendation,options_json,requires_approval,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    [empresaId, Date.now() % 2_000_000_000, 'crise_reputacional', 'high', 'critical', 'pg concurrency', '[]', 'teste', JSON.stringify(options), 1, 'pending', new Date().toISOString()],
  );
  const decisionId = Number(seeded.lastID);
  assert.ok(decisionId > 0, 'decisão de teste deve ser criada');
  try {
    const args = [empresaId, String(decisionId), 'opcao_pg'];
    const results = await Promise.all([
      runNodeScript(PREPARE_WORKER, args, workerEnv(), WORKER_TIMEOUT_MS),
      runNodeScript(PREPARE_WORKER, args, workerEnv(), WORKER_TIMEOUT_MS),
    ]);
    const resultA = parseWorkerJson<{ id: number; status: string }>(results[0], 'prepare-worker-1');
    const resultB = parseWorkerJson<{ id: number; status: string }>(results[1], 'prepare-worker-2');
    assert.equal(resultA.id, resultB.id, 'ambas as instâncias devem receber o mesmo ID idempotente');
    const actions = await db.all('SELECT id,status FROM dot_action_queue WHERE empresa_id = ? AND decision_id = ?', [empresaId, decisionId]);
    assert.equal(actions.length, 1, 'deve existir exatamente uma ação');
    assert.equal(String(actions[0].status), 'prepared');
    const audits = await db.all("SELECT id FROM dot_action_audit WHERE empresa_id = ? AND decision_id = ? AND event = 'prepared'", [empresaId, decisionId]);
    assert.equal(audits.length, 1, 'deve existir exatamente um evento prepared');
  } finally {
    await db.run('DELETE FROM dot_action_audit WHERE empresa_id = ?', [empresaId]);
    await db.run('DELETE FROM dot_action_queue WHERE empresa_id = ?', [empresaId]);
    await db.run('DELETE FROM dot_decisions WHERE empresa_id = ?', [empresaId]);
    await closeDB();
  }
});


test('duas instâncias PostgreSQL não aprovam duas vezes a mesma ação', async () => {
  assert.ok(databaseUrl(), 'DATABASE_URL de teste é obrigatória');
  process.env.NODE_ENV = 'test';
  await initDB();
  const db = getDb();
  const empresaId = `pg-approve-concurrency-${crypto.randomUUID()}`;
  const options = [{ id: 'opcao_aprovacao', title: 'Teste', action: 'priorizar_e_resolver', risk: 'medium' }];
  const seeded = await db.run(
    `INSERT INTO dot_decisions
      (empresa_id,event_id,type,priority,severity,reason,evidence_json,recommendation,options_json,requires_approval,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    [empresaId, Date.now() % 2_000_000_000, 'crise_reputacional', 'high', 'critical', 'pg approval concurrency', '[]', 'teste', JSON.stringify(options), 1, 'pending', new Date().toISOString()],
  );
  const decisionId = Number(seeded.lastID);
  assert.ok(decisionId > 0);
  try {
    const prepared = await (await import('../services/dotActionQueue.js')).prepareDotActionFromDecision(
      empresaId, decisionId, 'opcao_aprovacao', 'pg-test-owner',
    );
    assert.ok(prepared?.id);
    const args = [empresaId, String(prepared.id), 'pg-approver'];
    const outputs = await Promise.all([
      runNodeScript(APPROVE_WORKER, args, workerEnv(), WORKER_TIMEOUT_MS),
      runNodeScript(APPROVE_WORKER, args, workerEnv(), WORKER_TIMEOUT_MS),
    ]);
    const results = outputs.map((output, index) => parseWorkerJson<any>(output, `approve-worker-${index + 1}`));
    assert.equal(results.filter((result) => result?.status === 'approved').length, 1,
      'exatamente uma instância deve concluir a aprovação');
    assert.equal(results.filter((result) => result === null).length, 1,
      'a segunda instância deve observar que a ação já foi consumida');
    const action = await db.get(
      'SELECT status FROM dot_action_queue WHERE empresa_id = ? AND id = ?',
      [empresaId, prepared.id],
    );
    assert.equal(String(action?.status), 'approved');
    const decision = await db.get(
      'SELECT status FROM dot_decisions WHERE empresa_id = ? AND id = ?',
      [empresaId, decisionId],
    );
    assert.equal(String(decision?.status), 'approved');
    const audits = await db.all(
      "SELECT id FROM dot_action_audit WHERE empresa_id = ? AND decision_id = ? AND event = 'approved'",
      [empresaId, decisionId],
    );
    assert.equal(audits.length, 1, 'deve existir exatamente um evento approved');
  } finally {
    await db.run('DELETE FROM dot_action_audit WHERE empresa_id = ?', [empresaId]);
    await db.run('DELETE FROM dot_action_queue WHERE empresa_id = ?', [empresaId]);
    await db.run('DELETE FROM dot_decisions WHERE empresa_id = ?', [empresaId]);
    await closeDB();
  }
});
