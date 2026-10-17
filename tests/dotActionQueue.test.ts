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

const queueTest = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !sqliteAvailable }, fn);
import { initDB, getDb } from '../lib/db.js';
import { ensureDotAccessSchema } from '../services/dotAccessControl.js';
import {
  prepareDotActionFromDecision,
  approveDotAction,
  executeDotAction,
  listDotActions,
} from '../services/dotActionQueue.js';

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = '/tmp/filtra-dot-action-queue-test.sqlite';

let ready = false;

async function setup() {
  if (ready) return;
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
  // Garante o schema da fila em banco limpo (o setup original só funcionava
  // com um arquivo de banco já "quente" de execuções anteriores).
  await listDotActions('__schema_bootstrap__');
  await db.run('DELETE FROM dot_action_queue');
  await db.run('DELETE FROM dot_decisions');
  await ensureDotAccessSchema();
  await db.run('DELETE FROM dot_access_audit');
  ready = true;
}

async function seedDecision(empresaId: string) {
  const db = getDb();
  const options = [
    { id: 'opcao_1', title: 'Resolver diretamente', action: 'priorizar_e_resolver', risk: 'medium' },
    { id: 'opcao_2', title: 'Escalar para responsável', action: 'escalar_responsavel', risk: 'low' },
  ];
  const r = await db.run(
    `INSERT INTO dot_decisions
      (empresa_id,event_id,type,priority,severity,reason,evidence_json,recommendation,options_json,requires_approval,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [empresaId, Date.now(), 'crise_reputacional', 'high', 'critical', 'teste', '[]', 'teste', JSON.stringify(options), 1, 'pending', new Date().toISOString()]
  );
  await db.run(`INSERT INTO dot_agent_permissions (empresa_id,user_id,resource,action,granted,granted_by,granted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`, [empresaId, null, 'operations', 'execute', 1, 'test', new Date().toISOString(), new Date().toISOString(), new Date().toISOString()]);
  return Number(r.lastID);
}

queueTest('Dot action queue: prepare is tenant-scoped and blocks a second active option', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const otherEmpresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);

  const first = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1');
  assert.ok(first);
  assert.equal(first?.status, 'prepared');

  const second = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_2');
  assert.ok(second);
  assert.equal(second?.optionId, 'opcao_1');

  const crossTenant = await prepareDotActionFromDecision(otherEmpresa, decisionId, 'opcao_1');
  assert.equal(crossTenant, null);
});

queueTest('Dot action queue: approval is one-way and execution is replay-safe', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1');
  assert.ok(prepared?.id);

  const approved = await approveDotAction(empresa, Number(prepared.id));
  assert.equal(approved?.status, 'approved');

  const replayApproval = await approveDotAction(empresa, Number(prepared.id));
  assert.equal(replayApproval, null);

  const executed = await executeDotAction(empresa, Number(prepared.id));
  assert.equal(executed.ok, true);
  assert.equal(executed.status, 'executed');
  assert.equal(executed.simulated, false);

  const db = getDb();
  const internalCase = await db.get(
    'SELECT action, status, action_id FROM dot_internal_cases WHERE empresa_id = ? AND action_id = ?',
    [empresa, Number(prepared.id)]
  );
  assert.equal(internalCase?.action, 'priorizar_e_resolver');
  assert.equal(internalCase?.status, 'prioritized');
  assert.equal(Number(internalCase?.action_id), Number(prepared.id));

  const replayExecution = await executeDotAction(empresa, Number(prepared.id));
  assert.equal(replayExecution.ok, false);
});

queueTest('Dot action queue: concurrent approvals consume the same action only once', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1');
  assert.ok(prepared?.id);

  const results = await Promise.all([
    approveDotAction(empresa, Number(prepared.id)),
    approveDotAction(empresa, Number(prepared.id)),
  ]);

  assert.equal(results.filter((item) => item?.status === 'approved').length, 1);
  assert.equal(results.filter((item) => item === null).length, 1);

  const db = getDb();
  const action = await db.get(
    'SELECT status, approved_at FROM dot_action_queue WHERE id = ? AND empresa_id = ?',
    [prepared.id, empresa]
  );
  const decision = await db.get(
    'SELECT status FROM dot_decisions WHERE id = ? AND empresa_id = ?',
    [decisionId, empresa]
  );
  assert.equal(action?.status, 'approved');
  assert.ok(action?.approved_at);
  assert.equal(decision?.status, 'approved');
});

queueTest('Dot action queue: execution requires explicit permission', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1');
  assert.ok(prepared?.id);
  const approved = await approveDotAction(empresa, Number(prepared.id));
  assert.equal(approved?.status, 'approved');

  const db = getDb();
  await db.run('DELETE FROM dot_agent_permissions WHERE empresa_id = ? AND resource = ? AND action = ?', [empresa, 'operations', 'execute']);
  const blocked = await executeDotAction(empresa, Number(prepared.id));
  assert.equal(blocked.ok, false);
  assert.match(String(blocked.reason || ''), /permissão|permission/i);

  await db.run(
    'INSERT INTO dot_agent_permissions (empresa_id,user_id,resource,action,granted,granted_by,granted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [empresa, null, 'operations', 'execute', 1, 'test', new Date().toISOString(), new Date().toISOString(), new Date().toISOString()]
  );
  const allowed = await executeDotAction(empresa, Number(prepared.id));
  assert.equal(allowed.ok, true);
  assert.equal(allowed.status, 'executed');
});

queueTest('Dot action queue: an action cannot execute before approval', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1');
  assert.ok(prepared?.id);

  const result = await executeDotAction(empresa, Number(prepared.id));
  assert.equal(result.ok, false);
});
