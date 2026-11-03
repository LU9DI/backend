/**
 * Separação de funções na aprovação do Dot.
 *
 * Regras provadas aqui:
 *  - o preparador é identificado pela trilha auditável (`dot_action_audit.event
 *    = 'prepared'`), nunca por payload;
 *  - a AUSÊNCIA do evento `prepared` BLOQUEIA a aprovação; a única exceção é um
 *    marcador explícito, verificável e restrito de migração por (empresa, ação);
 *  - o mesmo usuário não aprova a própria preparação, salvo o owner verificado
 *    em `empresa_owners` (exceção auditada);
 *  - identidade ausente/ inválida é REJEITADA (nunca vira ator `dot`);
 *  - ator interno só age quando explicitamente declarado.
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
const dbPath = path.join(os.tmpdir(), `filtra-dot-sod-${Date.now()}.sqlite`);
process.env.SQLITE_DB_PATH = dbPath;
delete process.env.DATABASE_URL;

import { closeDB, getDb, initDB } from '../lib/db.js';
import {
  approveDotAction,
  DotApprovalSeparationError,
  prepareDotActionFromDecision,
} from '../services/dotActionQueue.js';
import { DotActorIdentityError, dotInternalActor, dotUserActor } from '../services/dotActor.js';

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
  await db.exec(`
    CREATE TABLE IF NOT EXISTS empresa_owners (
      empresa_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provisioned_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  ready = true;
}

async function seedDecision(empresaId: string) {
  const db = getDb();
  const options = [
    { id: 'opcao_1', title: 'Resolver', action: 'priorizar_e_resolver', risk: 'medium' },
    { id: 'opcao_2', title: 'Escalar', action: 'escalar_responsavel', risk: 'low' },
  ];
  const result = await db.run(
    `INSERT INTO dot_decisions
      (empresa_id,event_id,type,priority,severity,reason,evidence_json,recommendation,options_json,requires_approval,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [empresaId, Date.now() % 2_000_000_000, 'crise_reputacional', 'high', 'critical', 'sod', '[]', 'teste', JSON.stringify(options), 1, 'pending', new Date().toISOString()],
  );
  return Number(result.lastID);
}

async function approvalAudit(empresaId: string, actionId: number) {
  const db = getDb();
  const row: any = await db.get(
    `SELECT metadata FROM dot_action_audit
      WHERE empresa_id = ? AND action_id = ? AND event = 'approved'
      ORDER BY id DESC LIMIT 1`,
    [empresaId, actionId],
  );
  return row?.metadata ? JSON.parse(String(row.metadata)) : null;
}

async function assertNotApproved(empresaId: string, actionId: number, decisionId: number) {
  const db = getDb();
  const action: any = await db.get('SELECT status, approved_at FROM dot_action_queue WHERE empresa_id=? AND id=?', [empresaId, actionId]);
  assert.equal(action.status, 'prepared');
  assert.equal(action.approved_at, null);
  const decision: any = await db.get('SELECT status FROM dot_decisions WHERE empresa_id=? AND id=?', [empresaId, decisionId]);
  assert.equal(decision.status, 'prepared');
  const approvedAudits = await db.all(
    "SELECT id FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='approved'",
    [empresaId, actionId],
  );
  assert.equal(approvedAudits.length, 0, 'não pode existir evento approved após bloqueio');
}

runTest('preparador não pode aprovar a própria ação (mesmo usuário, sem owner)', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1', 'user-preparer');
  assert.ok(prepared?.id);

  await assert.rejects(
    () => approveDotAction(empresa, prepared!.id, dotUserActor('user-preparer')),
    (error: any) => error instanceof DotApprovalSeparationError && error.code === 'DOT_SEPARATION_OF_DUTIES' && error.status === 403,
  );

  // Rollback: a ação volta a estar preparada e sem aprovação auditada.
  await assertNotApproved(empresa, prepared!.id, decisionId);
});

runTest('aprovador distinto é aceito e a decisão fica registrada', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1', 'preparer-a');
  const approved = await approveDotAction(empresa, prepared!.id, dotUserActor('approver-b'));
  assert.equal(approved?.status, 'approved');
  assert.equal((approved as any).separation, 'distinct_actors');
  const metadata = await approvalAudit(empresa, prepared!.id);
  assert.equal(metadata.separation_decision, 'distinct_actors');
  assert.equal(metadata.owner_override, false);
  assert.equal(metadata.preparer_id, 'preparer-a');
  assert.equal(metadata.approver_id, 'approver-b');
  assert.equal(metadata.approver_actor_type, 'user');
});

runTest('owner autoritativo pode aprovar a própria preparação como exceção auditada', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const db = getDb();
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO empresa_owners (empresa_id,user_id,provisioned_by,created_at,updated_at) VALUES (?,?,?,?,?)',
    [empresa, 'owner-user', 'test', now, now],
  );
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1', 'owner-user');
  const approved = await approveDotAction(empresa, prepared!.id, dotUserActor('owner-user'));
  assert.equal(approved?.status, 'approved');
  assert.equal((approved as any).separation, 'owner_override');
  assert.equal((approved as any).ownerOverride, true);
  const metadata = await approvalAudit(empresa, prepared!.id);
  assert.equal(metadata.separation_decision, 'owner_override');
  assert.equal(metadata.owner_override, true);
  assert.equal(metadata.preparer_id, 'owner-user');
  assert.equal(metadata.approver_id, 'owner-user');
});

runTest('preparação automática do Dot + aprovação humana registra internal_actor', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1');
  const approved = await approveDotAction(empresa, prepared!.id, dotUserActor('human-approver'));
  assert.equal(approved?.status, 'approved');
  assert.equal((approved as any).separation, 'internal_actor');
  const metadata = await approvalAudit(empresa, prepared!.id);
  assert.equal(metadata.separation_decision, 'internal_actor');
  assert.equal(metadata.preparer_actor_type, 'dot');
  assert.equal(metadata.preparer_id, null);
  assert.equal(metadata.approver_actor_type, 'user');
  assert.equal(metadata.approver_id, 'human-approver');
});

runTest('identidade humana ausente ou em branco é rejeitada e não aprova', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1', 'human-preparer');

  // Ausência/identidade inválida não vira `dot`: é rejeitada de imediato.
  await assert.rejects(
    async () => approveDotAction(empresa, prepared!.id, dotUserActor('   ')),
    (error: any) => error instanceof DotActorIdentityError && error.code === 'DOT_ACTOR_IDENTITY_REQUIRED',
  );
  await assert.rejects(
    () => approveDotAction(empresa, prepared!.id, undefined as any),
    (error: any) => error instanceof DotActorIdentityError,
  );

  await assertNotApproved(empresa, prepared!.id, decisionId);
});

runTest('ator interno explícito aprova preparação do Dot e é auditado como dot/null', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1');

  const approved = await approveDotAction(empresa, prepared!.id, dotInternalActor('scheduler'));
  assert.equal(approved?.status, 'approved');
  assert.equal((approved as any).separation, 'internal_actor');

  const db = getDb();
  const audit: any = await db.get(
    "SELECT actor_type, actor_id, metadata FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='approved' ORDER BY id DESC LIMIT 1",
    [empresa, prepared!.id],
  );
  assert.equal(String(audit.actor_type), 'dot');
  assert.equal(audit.actor_id, null, 'ator interno nunca registra usuário anônimo');
  const metadata = JSON.parse(String(audit.metadata));
  assert.equal(metadata.approver_actor_type, 'dot');
  assert.equal(metadata.approver_id, null);
  assert.equal(metadata.approver_source, 'scheduler');
});

runTest('ator interno não aprova ação preparada por usuário humano', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1', 'human-preparer');

  await assert.rejects(
    () => approveDotAction(empresa, prepared!.id, dotInternalActor('monitor')),
    (error: any) => error instanceof DotApprovalSeparationError && error.code === 'DOT_SEPARATION_OF_DUTIES',
  );
  await assertNotApproved(empresa, prepared!.id, decisionId);
});

runTest('evento prepared dot com actor_id preenchido é histórico inválido e bloqueia', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1');
  const db = getDb();
  // Contrato: actor_type='dot' exige actor_id NULL. Simula histórico corrompido.
  await db.run(
    "UPDATE dot_action_audit SET actor_id = 'ghost-dot-actor' WHERE empresa_id=? AND action_id=? AND event='prepared'",
    [empresa, prepared!.id],
  );

  await assert.rejects(
    () => approveDotAction(empresa, prepared!.id, dotUserActor('human-approver')),
    (error: any) => error instanceof DotApprovalSeparationError && error.code === 'DOT_SEPARATION_OF_DUTIES',
  );
  await assertNotApproved(empresa, prepared!.id, decisionId);
});

runTest('ausência de evento prepared bloqueia a aprovação (sem marcador)', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1', 'legacy-preparer');
  const db = getDb();
  await db.run("DELETE FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='prepared'", [empresa, prepared!.id]);

  // Não presumir preparação pelo Dot a partir da ausência de auditoria.
  await assert.rejects(
    () => approveDotAction(empresa, prepared!.id, dotUserActor('legacy-preparer')),
    (error: any) => error instanceof DotApprovalSeparationError && error.code === 'DOT_SEPARATION_OF_DUTIES',
  );
  await assertNotApproved(empresa, prepared!.id, decisionId);
});

runTest('compatibilidade histórica só com marcador explícito e restrito de migração', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1', 'legacy-preparer');
  const db = getDb();
  await db.run("DELETE FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='prepared'", [empresa, prepared!.id]);

  const markerNow = new Date().toISOString();
  await db.run(
    `INSERT INTO dot_action_legacy_approval_markers
       (empresa_id, action_id, marker, reason, created_by, created_at)
     VALUES (?,?,?,?,?,?)`,
    [empresa, prepared!.id, 'no_preparer_recorded_v1', 'dados legados pré-auditoria', 'operator', markerNow],
  );

  const approved = await approveDotAction(empresa, prepared!.id, dotUserActor('legacy-preparer'));
  assert.equal(approved?.status, 'approved');
  assert.equal((approved as any).separation, 'no_preparer_recorded');
  const metadata = await approvalAudit(empresa, prepared!.id);
  assert.equal(metadata.separation_decision, 'no_preparer_recorded');
  assert.equal(metadata.preparer_id, null);
  assert.equal(metadata.legacy_migration_marker, 'no_preparer_recorded_v1');

  // O marcador é restrito por (empresa, ação): outra ação sem marcador segue
  // bloqueada, mesmo que a empresa já tenha um marcador em outra ação.
  const outraDecision = await seedDecision(empresa);
  const outra = await prepareDotActionFromDecision(empresa, outraDecision, 'opcao_1', 'legacy-preparer');
  await db.run("DELETE FROM dot_action_audit WHERE empresa_id=? AND action_id=? AND event='prepared'", [empresa, outra!.id]);
  await assert.rejects(
    () => approveDotAction(empresa, outra!.id, dotUserActor('legacy-preparer')),
    (error: any) => error instanceof DotApprovalSeparationError,
  );
  await assertNotApproved(empresa, outra!.id, outraDecision);
});

runTest('contrato de ator inválido nunca é convertido em dot', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1');
  const db = getDb();

  const invalidActors = [
    undefined,
    null,
    'owner-1',
    { type: 'admin', userId: 'x' },
    { type: 'dot', source: 'unknown' },
    { type: 'user' },
    { type: 'user', userId: '' },
  ];
  for (const invalid of invalidActors) {
    await assert.rejects(
      () => approveDotAction(empresa, prepared!.id, invalid as any),
      (error: any) => error instanceof DotActorIdentityError && error.code === 'DOT_ACTOR_IDENTITY_REQUIRED',
      `ator inválido deveria ser rejeitado: ${JSON.stringify(invalid)}`,
    );
  }
  const action: any = await db.get('SELECT status FROM dot_action_queue WHERE empresa_id=? AND id=?', [empresa, prepared!.id]);
  assert.equal(action.status, 'prepared');
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
