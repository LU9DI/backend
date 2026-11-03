/**
 * Contraprova em PostgreSQL real da execução atômica e da separação de funções.
 *
 * Roda apenas em `npm run test:postgres`, com DATABASE_URL apontando para um
 * PostgreSQL descartável. Usa um tenant único e limpa apenas as próprias linhas.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { closeDB, getDb, initDB } from '../lib/db.js';
import { ensureDotAccessSchema } from '../services/dotAccessControl.js';
import {
  approveDotAction,
  DotApprovalSeparationError,
  executeDotAction,
  prepareDotActionFromDecision,
} from '../services/dotActionQueue.js';
import { dotInternalActor, dotUserActor } from '../services/dotActor.js';

process.env.NODE_ENV = 'test';

function requireDatabaseUrl() {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL de teste PostgreSQL é obrigatória');
}

async function ensureDecisionTable() {
  const db = getDb();
  await ensureDotAccessSchema();
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
}

async function seedApprovedAction(empresaId: string) {
  const db = getDb();
  const decision = await db.run(
    `INSERT INTO dot_decisions
      (empresa_id,event_id,type,priority,severity,reason,evidence_json,recommendation,options_json,requires_approval,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    [empresaId, Date.now() % 2_000_000_000, 'crise_reputacional', 'high', 'critical', 'pg atomicity', '[]', 'teste', '[]', 1, 'approved', new Date().toISOString()],
  );
  const decisionId = Number(decision.lastID);
  const action = await db.run(
    `INSERT INTO dot_action_queue
      (empresa_id,decision_id,option_id,action,status,approved_at,created_at)
     VALUES (?,?,?,?,?,?,?) RETURNING id`,
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

async function cleanup(empresaId: string) {
  const db = getDb();
  for (const table of ['dot_action_audit', 'dot_internal_cases', 'dot_followups', 'dot_action_queue', 'dot_decisions', 'dot_agent_permissions']) {
    await db.run(`DELETE FROM ${table} WHERE empresa_id = ?`, [empresaId]);
  }
}

test('PostgreSQL: falha no follow-up reverte claim, caso e auditoria inicial', async () => {
  requireDatabaseUrl();
  await initDB();
  await ensureDecisionTable();
  const db = getDb();
  const empresa = `pg-atomic-${crypto.randomUUID()}`;
  try {
    const { actionId } = await seedApprovedAction(empresa);
    await db.exec(
      `ALTER TABLE dot_followups DROP CONSTRAINT IF EXISTS pg_fail_followup_check;
       ALTER TABLE dot_followups ADD CONSTRAINT pg_fail_followup_check CHECK (empresa_id <> '${empresa}') NOT VALID;`,
    );

    const failed = await executeDotAction(empresa, actionId, dotUserActor('owner-test'));
    assert.equal(failed.ok, false, JSON.stringify(failed));
    assert.equal(failed.status, 'approved');

    const action: any = await db.get('SELECT status FROM dot_action_queue WHERE empresa_id=? AND id=?', [empresa, actionId]);
    assert.equal(action.status, 'approved', 'rollback deve preservar approved');
    const cases: any = await db.get('SELECT COUNT(*) AS c FROM dot_internal_cases WHERE empresa_id=? AND action_id=?', [empresa, actionId]);
    assert.equal(Number(cases.c), 0, 'caso não pode sobreviver ao rollback');
    const followups: any = await db.get('SELECT COUNT(*) AS c FROM dot_followups WHERE empresa_id=? AND action_id=?', [empresa, actionId]);
    assert.equal(Number(followups.c), 0);
    const started: any = await db.get("SELECT COUNT(*) AS c FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='execution_started'", [empresa, actionId]);
    assert.equal(Number(started.c), 0);
    const executed: any = await db.get("SELECT COUNT(*) AS c FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='executed'", [empresa, actionId]);
    assert.equal(Number(executed.c), 0);
    const failedAudit: any = await db.get("SELECT actor_type, actor_id, metadata FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='failed'", [empresa, actionId]);
    assert.equal(String(failedAudit.actor_type), 'user');
    assert.equal(String(failedAudit.actor_id), 'owner-test');
    const metadata = JSON.parse(String(failedAudit.metadata));
    assert.equal(metadata.rolled_back, true);
    assert.equal(metadata.phase, 'follow_up');

    await db.exec('ALTER TABLE dot_followups DROP CONSTRAINT IF EXISTS pg_fail_followup_check');
    const retry = await executeDotAction(empresa, actionId, dotUserActor('owner-test'));
    assert.equal(retry.ok, true, JSON.stringify(retry));
    const executedAfter: any = await db.get('SELECT status FROM dot_action_queue WHERE empresa_id=? AND id=?', [empresa, actionId]);
    assert.equal(executedAfter.status, 'executed');
  } finally {
    await db.exec('ALTER TABLE dot_followups DROP CONSTRAINT IF EXISTS pg_fail_followup_check').catch(() => undefined);
    await cleanup(empresa);
    await closeDB();
  }
});

test('PostgreSQL: duas execuções concorrentes têm um único vencedor', async () => {
  requireDatabaseUrl();
  await initDB();
  await ensureDecisionTable();
  const db = getDb();
  const empresa = `pg-exec-concurrent-${crypto.randomUUID()}`;
  try {
    const { actionId } = await seedApprovedAction(empresa);
    const results = await Promise.all([
      executeDotAction(empresa, actionId, dotUserActor('owner-a')),
      executeDotAction(empresa, actionId, dotUserActor('owner-b')),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
    const cases: any = await db.get('SELECT COUNT(*) AS c FROM dot_internal_cases WHERE empresa_id=? AND action_id=?', [empresa, actionId]);
    assert.equal(Number(cases.c), 1);
    const followups: any = await db.get('SELECT COUNT(*) AS c FROM dot_followups WHERE empresa_id=? AND action_id=?', [empresa, actionId]);
    assert.equal(Number(followups.c), 1);
    const executed: any = await db.get("SELECT COUNT(*) AS c FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='executed'", [empresa, actionId]);
    assert.equal(Number(executed.c), 1);
  } finally {
    await cleanup(empresa);
    await closeDB();
  }
});

test('PostgreSQL: separação de funções bloqueia o próprio preparador e libera o owner', async () => {
  requireDatabaseUrl();
  await initDB();
  await ensureDecisionTable();
  const db = getDb();
  const empresa = `pg-sod-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS empresa_owners (
        empresa_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provisioned_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const options = [{ id: 'opcao_1', title: 'Teste', action: 'priorizar_e_resolver', risk: 'medium' }];
    async function seedDecision() {
      const result = await db.run(
        `INSERT INTO dot_decisions
          (empresa_id,event_id,type,priority,severity,reason,evidence_json,recommendation,options_json,requires_approval,status,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        [empresa, Date.now() % 2_000_000_000, 'crise_reputacional', 'high', 'critical', 'pg sod', '[]', 'teste', JSON.stringify(options), 1, 'pending', now],
      );
      return Number(result.lastID);
    }

    const d1 = await seedDecision();
    const p1 = await prepareDotActionFromDecision(empresa, d1, 'opcao_1', 'same-user');
    await assert.rejects(
      () => approveDotAction(empresa, p1!.id, dotUserActor('same-user')),
      (error: any) => error instanceof DotApprovalSeparationError && error.code === 'DOT_SEPARATION_OF_DUTIES',
    );
    const action: any = await db.get('SELECT status FROM dot_action_queue WHERE empresa_id=? AND id=?', [empresa, p1!.id]);
    assert.equal(action.status, 'prepared', 'rollback deve manter prepared');

    await db.run(
      'INSERT INTO empresa_owners (empresa_id,user_id,provisioned_by,created_at,updated_at) VALUES (?,?,?,?,?)',
      [empresa, 'same-user', 'test', now, now],
    );
    const d2 = await seedDecision();
    const p2 = await prepareDotActionFromDecision(empresa, d2, 'opcao_1', 'same-user');
    const approved = await approveDotAction(empresa, p2!.id, dotUserActor('same-user'));
    assert.equal(approved?.status, 'approved');
    assert.equal((approved as any).separation, 'owner_override');
  } finally {
    await cleanup(empresa);
    await closeDB();
  }
});

test('PostgreSQL: ausência de prepared bloqueia e marcador explícito libera legado', async () => {
  requireDatabaseUrl();
  await initDB();
  await ensureDecisionTable();
  const db = getDb();
  const empresa = `pg-no-prepared-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  try {
    const options = [{ id: 'opcao_1', title: 'Teste', action: 'priorizar_e_resolver', risk: 'medium' }];
    const inserted = await db.run(
      `INSERT INTO dot_decisions
        (empresa_id,event_id,type,priority,severity,reason,evidence_json,recommendation,options_json,requires_approval,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      [empresa, Date.now() % 2_000_000_000, 'crise_reputacional', 'high', 'critical', 'pg no prepared', '[]', 'teste', JSON.stringify(options), 1, 'pending', now],
    );
    const decisionId = Number(inserted.lastID);
    const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1', 'human-preparer');
    assert.ok(prepared?.id);
    // Simula histórico sem evento `prepared` (o caso que deve ser bloqueado).
    await db.run("DELETE FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='prepared'", [empresa, prepared!.id]);

    await assert.rejects(
      () => approveDotAction(empresa, prepared!.id, dotUserActor('human-approver')),
      (error: any) => error instanceof DotApprovalSeparationError && error.code === 'DOT_SEPARATION_OF_DUTIES',
    );
    const blocked: any = await db.get('SELECT status, approved_at FROM dot_action_queue WHERE empresa_id=? AND id=?', [empresa, prepared!.id]);
    assert.equal(String(blocked.status), 'prepared', 'bloqueio não altera a fila');
    assert.equal(blocked.approved_at, null);
    const decision: any = await db.get('SELECT status FROM dot_decisions WHERE empresa_id=? AND id=?', [empresa, decisionId]);
    assert.equal(String(decision.status), 'prepared', 'bloqueio não altera a decisão');
    const approvedCount: any = await db.get("SELECT COUNT(*) AS c FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='approved'", [empresa, prepared!.id]);
    assert.equal(Number(approvedCount.c), 0, 'bloqueio não grava auditoria de aprovação');

    // Marcador explícito, verificável e restrito de migração (operação
    // administrativa deliberada; nunca inserido pelo fluxo normal).
    await db.run(
      `INSERT INTO dot_action_legacy_approval_markers (empresa_id,action_id,marker,reason,created_by,created_at)
       VALUES (?,?,?,?,?,?)`,
      [empresa, prepared!.id, 'no_preparer_recorded_v1', 'dados legados pré-auditoria', 'test-operator', now],
    );
    const legacy = await approveDotAction(empresa, prepared!.id, dotUserActor('human-approver'));
    assert.equal(legacy?.status, 'approved');
    assert.equal((legacy as any).separation, 'no_preparer_recorded');
    const audit: any = await db.get(
      "SELECT metadata FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='approved' ORDER BY id DESC LIMIT 1",
      [empresa, prepared!.id],
    );
    assert.equal(JSON.parse(String(audit.metadata)).legacy_migration_marker, 'no_preparer_recorded_v1');
  } finally {
    await db.run('DELETE FROM dot_action_legacy_approval_markers WHERE empresa_id=?', [empresa]).catch(() => undefined);
    await cleanup(empresa);
    await closeDB();
  }
});

test('PostgreSQL: ator interno é auditado como dot nos três eventos de execução', async () => {
  requireDatabaseUrl();
  await initDB();
  await ensureDecisionTable();
  const db = getDb();
  const empresa = `pg-internal-actor-${crypto.randomUUID()}`;
  try {
    const { actionId } = await seedApprovedAction(empresa);
    const result = await executeDotAction(empresa, actionId, dotInternalActor('scheduler'));
    assert.equal(result.ok, true, JSON.stringify(result));
    const rows: any[] = await db.all(
      "SELECT event, actor_type, actor_id FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event IN ('execution_started','executed') ORDER BY id",
      [empresa, actionId],
    );
    assert.deepEqual(rows.map((row) => String(row.event)), ['execution_started', 'executed']);
    for (const row of rows) {
      assert.equal(String(row.actor_type), 'dot');
      assert.equal(row.actor_id, null, 'ator interno nunca registra usuário anônimo');
    }

    // Falha fora da transação também preserva o ator interno.
    const failedSeed = await seedApprovedAction(empresa);
    await db.exec(
      `ALTER TABLE dot_followups DROP CONSTRAINT IF EXISTS pg_fail_internal_followup_check;
       ALTER TABLE dot_followups ADD CONSTRAINT pg_fail_internal_followup_check CHECK (action_id <> ${failedSeed.actionId}) NOT VALID;`,
    );
    try {
      const failed = await executeDotAction(empresa, failedSeed.actionId, dotInternalActor('monitor'));
      assert.equal(failed.ok, false);
      const failedAudit: any = await db.get(
        "SELECT actor_type, actor_id, metadata FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='failed'",
        [empresa, failedSeed.actionId],
      );
      assert.equal(String(failedAudit.actor_type), 'dot');
      assert.equal(failedAudit.actor_id, null);
      assert.equal(JSON.parse(String(failedAudit.metadata)).actor_source, 'monitor');
    } finally {
      await db.exec('ALTER TABLE dot_followups DROP CONSTRAINT IF EXISTS pg_fail_internal_followup_check').catch(() => undefined);
    }
  } finally {
    await cleanup(empresa);
    await closeDB();
  }
});
