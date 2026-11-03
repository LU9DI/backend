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
import { DotActorIdentityError, dotInternalActor, dotUserActor } from '../services/dotActor.js';

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

queueTest('Dot action queue: prepare is tenant-scoped and rejects a second active option', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const otherEmpresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);

  const first = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1');
  assert.ok(first);
  assert.equal(first?.status, 'prepared');

  await assert.rejects(
    () => prepareDotActionFromDecision(empresa, decisionId, 'opcao_2'),
    { code: 'DOT_ACTION_OPTION_CONFLICT' },
  );

  const crossTenant = await prepareDotActionFromDecision(otherEmpresa, decisionId, 'opcao_1');
  assert.equal(crossTenant, null);
});

queueTest('Dot action queue: approval is one-way and execution is replay-safe', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1');
  assert.ok(prepared?.id);

  const approved = await approveDotAction(empresa, Number(prepared.id), dotUserActor('approver-1'));
  assert.equal(approved?.status, 'approved');

  const approvalAudit = await getDb().get(
    "SELECT actor_type, actor_id FROM dot_action_audit WHERE empresa_id = ? AND action_id = ? AND event = 'approved' ORDER BY id DESC LIMIT 1",
    [empresa, Number(prepared.id)],
  );
  assert.equal(approvalAudit?.actor_type, 'user');
  assert.equal(String(approvalAudit?.actor_id), 'approver-1');

  const replayApproval = await approveDotAction(empresa, Number(prepared.id), dotUserActor('approver-1'));
  assert.equal(replayApproval, null);

  const executed = await executeDotAction(empresa, Number(prepared.id), dotUserActor('executor-1'));
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

  const replayExecution = await executeDotAction(empresa, Number(prepared.id), dotUserActor('executor-1'));
  assert.equal(replayExecution.ok, false);
});

queueTest('Dot action queue: audit failure rolls back approval state', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1');
  assert.ok(prepared?.id);

  const db = getDb();
  await db.exec(`
    CREATE TRIGGER fail_dot_approval_audit
    BEFORE INSERT ON dot_action_audit
    WHEN NEW.event = 'approved'
    BEGIN
      SELECT RAISE(ABORT, 'simulated audit failure');
    END
  `);

  try {
    await assert.rejects(
      approveDotAction(empresa, Number(prepared.id), dotUserActor('approver-rollback')),
      /simulated audit failure/i,
    );
  } finally {
    await db.exec('DROP TRIGGER IF EXISTS fail_dot_approval_audit');
  }

  const action = await db.get(
    'SELECT status, approved_at FROM dot_action_queue WHERE id = ? AND empresa_id = ?',
    [prepared.id, empresa],
  );
  const decision = await db.get(
    'SELECT status FROM dot_decisions WHERE id = ? AND empresa_id = ?',
    [decisionId, empresa],
  );
  const approvalAudit = await db.get(
    "SELECT id FROM dot_action_audit WHERE empresa_id = ? AND action_id = ? AND event = 'approved'",
    [empresa, Number(prepared.id)],
  );

  assert.equal(action?.status, 'prepared');
  assert.equal(action?.approved_at, null);
  assert.equal(decision?.status, 'prepared');
  assert.equal(approvalAudit, undefined);
});

queueTest('Dot action queue: concurrent approvals consume the same action only once', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1');
  assert.ok(prepared?.id);

  const results = await Promise.all([
    approveDotAction(empresa, Number(prepared.id), dotUserActor('approver-a')),
    approveDotAction(empresa, Number(prepared.id), dotUserActor('approver-b')),
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
  const approved = await approveDotAction(empresa, Number(prepared.id), dotUserActor('approver-1'));
  assert.equal(approved?.status, 'approved');

  const db = getDb();
  await db.run('DELETE FROM dot_agent_permissions WHERE empresa_id = ? AND resource = ? AND action = ?', [empresa, 'operations', 'execute']);
  const blocked = await executeDotAction(empresa, Number(prepared.id), dotUserActor('executor-1'));
  assert.equal(blocked.ok, false);
  assert.match(String(blocked.reason || ''), /permissão|permission/i);

  await db.run(
    'INSERT INTO dot_agent_permissions (empresa_id,user_id,resource,action,granted,granted_by,granted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [empresa, null, 'operations', 'execute', 1, 'test', new Date().toISOString(), new Date().toISOString(), new Date().toISOString()]
  );
  const allowed = await executeDotAction(empresa, Number(prepared.id), dotUserActor('executor-1'));
  assert.equal(allowed.ok, true);
  assert.equal(allowed.status, 'executed');
});

queueTest('Dot action queue: an action cannot execute before approval', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1');
  assert.ok(prepared?.id);

  const result = await executeDotAction(empresa, Number(prepared.id), dotUserActor('executor-1'));
  assert.equal(result.ok, false);
});

queueTest('Dot action queue: identidade ausente ou inválida é rejeitada sem efeito', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1');
  assert.ok(prepared?.id);

  // Sem ator, string solta e tipo desconhecido NÃO viram ator `dot`.
  for (const invalid of [undefined, null, 'owner-1' as any, { type: 'admin', userId: 'x' } as any, { type: 'user', userId: '   ' } as any]) {
    await assert.rejects(
      () => approveDotAction(empresa, Number(prepared.id), invalid),
      (error: any) => error instanceof DotActorIdentityError && error.code === 'DOT_ACTOR_IDENTITY_REQUIRED',
    );
  }
  await assert.rejects(
    () => executeDotAction(empresa, Number(prepared.id), undefined),
    (error: any) => error instanceof DotActorIdentityError,
  );

  // Nada foi alterado: ação segue preparada e sem evento approved.
  const db = getDb();
  const action: any = await db.get('SELECT status, approved_at FROM dot_action_queue WHERE empresa_id=? AND id=?', [empresa, prepared!.id]);
  assert.equal(action.status, 'prepared');
  assert.equal(action.approved_at, null);
  const approvedAudits = await db.all(
    "SELECT id FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='approved'",
    [empresa, prepared!.id],
  );
  assert.equal(approvedAudits.length, 0);

  // Ator interno explicitamente declarado continua permitido e auditado como dot.
  const internalApproval = await approveDotAction(empresa, Number(prepared.id), dotInternalActor('scheduler'));
  assert.equal(internalApproval?.status, 'approved');
  const audit: any = await db.get(
    "SELECT actor_type, actor_id FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='approved' ORDER BY id DESC LIMIT 1",
    [empresa, prepared!.id],
  );
  assert.equal(String(audit.actor_type), 'dot');
  assert.equal(audit.actor_id, null);
});
