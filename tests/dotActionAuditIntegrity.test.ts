/**
 * Regressão de integridade da auditoria de PREPARAÇÃO de ações do Dot.
 *
 * Cobre três correções feitas nesta auditoria:
 *  1. o ator autenticado que pede a preparação é registrado (`user` + id) em
 *     vez de aparecer sempre como `dot`;
 *  2. repetir a preparação NÃO duplica o evento `prepared` (idempotência da
 *     trilha), mantendo exatamente uma transição por ação;
 *  3. a auditoria passa a participar da mesma transação da criação da ação:
 *     falha ao gravar auditoria reverte a preparação (nunca existe ação
 *     preparada sem trilha).
 */
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

const auditTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !sqliteAvailable }, fn);

import { initDB, getDb } from '../lib/db.js';
import { ensureDotActionAuditSchema } from '../services/dotActionAudit.js';
import { listDotActions, prepareDotActionFromDecision } from '../services/dotActionQueue.js';

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = '/tmp/filtra-dot-action-audit-integrity-test.sqlite';

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
  await ensureDotActionAuditSchema();
  await listDotActions('__schema_bootstrap__');
  await db.run('DELETE FROM dot_action_queue');
  await db.run('DELETE FROM dot_action_audit');
  await db.run('DELETE FROM dot_decisions');
  ready = true;
}

async function seedDecision(empresaId: string) {
  const db = getDb();
  const options = [
    { id: 'opcao_1', title: 'Resolver diretamente', action: 'priorizar_e_resolver', risk: 'medium' },
    { id: 'opcao_2', title: 'Escalar para responsável', action: 'escalar_responsavel', risk: 'low' },
  ];
  const result = await db.run(
    `INSERT INTO dot_decisions
      (empresa_id,event_id,type,priority,severity,reason,evidence_json,recommendation,options_json,requires_approval,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      empresaId,
      Date.now(),
      'crise_reputacional',
      'high',
      'critical',
      'teste',
      '[]',
      'teste',
      JSON.stringify(options),
      1,
      'pending',
      new Date().toISOString(),
    ],
  );
  return Number(result.lastID);
}

async function preparedEvents(empresaId: string, actionId: number) {
  return getDb().all(
    "SELECT actor_type, actor_id FROM dot_action_audit WHERE empresa_id = ? AND action_id = ? AND event = 'prepared' ORDER BY id",
    [empresaId, actionId],
  );
}

auditTest('prepare registra o ator autenticado que pediu a preparação', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);

  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1', 'user-owner-1');
  assert.ok(prepared?.id);

  const events = await preparedEvents(empresa, Number(prepared.id));
  assert.equal(events.length, 1);
  assert.equal(String(events[0].actor_type), 'user');
  assert.equal(String(events[0].actor_id), 'user-owner-1');
});

auditTest('prepare automático do Dot continua auditado como ator dot, sem ator humano', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);

  const prepared = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1');
  assert.ok(prepared?.id);

  const events = await preparedEvents(empresa, Number(prepared.id));
  assert.equal(events.length, 1);
  assert.equal(String(events[0].actor_type), 'dot');
  assert.equal(events[0].actor_id, null);
});

auditTest('prepare repetido mantém exatamente uma transição prepared (idempotência da trilha)', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);

  const first = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1', 'user-owner-1');
  const second = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_2', 'user-owner-1');
  const third = await prepareDotActionFromDecision(empresa, decisionId, 'opcao_1', 'user-owner-1');
  assert.ok(first?.id && second?.id && third?.id);
  assert.equal(first!.id, second!.id);
  assert.equal(first!.id, third!.id);

  const events = await preparedEvents(empresa, Number(first!.id));
  assert.equal(events.length, 1, 'repetir a preparação não pode gerar eventos duplicados');

  const rows = await getDb().all(
    'SELECT id FROM dot_action_queue WHERE empresa_id = ? AND decision_id = ?',
    [empresa, decisionId],
  );
  assert.equal(rows.length, 1, 'apenas uma ação ativa por decisão');
});

auditTest('falha ao gravar a auditoria reverte a preparação (sem ação órfã)', async () => {
  await setup();
  const empresa = crypto.randomUUID();
  const decisionId = await seedDecision(empresa);
  const db = getDb();

  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS fail_dot_prepare_audit BEFORE INSERT ON dot_action_audit BEGIN SELECT RAISE(ABORT, 'audit insert failed'); END",
  );
  try {
    await assert.rejects(
      () => prepareDotActionFromDecision(empresa, decisionId, 'opcao_1', 'user-owner-1'),
      /audit insert failed/i,
    );
  } finally {
    await db.exec('DROP TRIGGER IF EXISTS fail_dot_prepare_audit');
  }

  const actions = await db.all(
    'SELECT id FROM dot_action_queue WHERE empresa_id = ? AND decision_id = ?',
    [empresa, decisionId],
  );
  assert.equal(actions.length, 0, 'a ação preparada não pode sobreviver à falha de auditoria');

  const decision = await db.get('SELECT status FROM dot_decisions WHERE id = ? AND empresa_id = ?', [
    decisionId,
    empresa,
  ]);
  assert.equal(String(decision?.status), 'pending', 'a decisão também deve voltar ao estado original');
});
