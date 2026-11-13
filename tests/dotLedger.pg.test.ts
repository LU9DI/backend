/**
 * Ledger do orçamento do Dot — PostgreSQL REAL.
 *
 * Executado por `npm run test:postgres` (nunca por `npm test`): exige
 * `DATABASE_URL` apontando para uma instância descartável, cria um banco
 * temporário e o derruba no `finally`.
 *
 * O que só o PostgreSQL pode provar:
 *  - a corrida de finalização entre DUAS instâncias (pools e conexões
 *    independentes) grava exatamente um consumo;
 *  - o índice único parcial `ux_dot_budget_reservations_ai_usage` existe e é
 *    respeitado;
 *  - a leitura do orçamento no mês compara timestamps de verdade
 *    (`TIMESTAMPTZ`), não texto;
 *  - a varredura de expiração e a finalização concorrentes não se sobrescrevem
 *    sob READ COMMITTED.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { createTestDatabase, dropTestDatabase, parseWorkerJson, runNodeScript } from './helpers/pg-test-utils.js';

const WORKER = new URL('./helpers/dot-ledger-worker.pg.ts', import.meta.url);
const WORKER_TIMEOUT_MS = 90_000;

let created: { name: string; url: string } | null = null;
let db: any;
let ledger: typeof import('../services/dotLedger.js');

function workerEnv(): NodeJS.ProcessEnv {
  assert.ok(created, 'banco de teste PostgreSQL não criado');
  return { DATABASE_URL: created.url };
}

const EMPRESA = `pg-ledger-${crypto.randomUUID()}`;
const EMPRESA_B = `pg-ledger-b-${crypto.randomUUID()}`;

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL de teste PostgreSQL é obrigatória');
  process.env.NODE_ENV = 'test';
  created = await createTestDatabase('filtra_dot_ledger');
  process.env.DATABASE_URL = created.url;
  const { initDB, getDb } = await import('../lib/db.js');
  await initDB();
  db = getDb();
  ledger = await import('../services/dotLedger.js');
  await ledger.ensureDotLedgerSchema();
});

after(async () => {
  try {
    const { closeDB } = await import('../lib/db.js');
    await closeDB();
  } catch {
    /* ok */
  }
  if (created) await dropTestDatabase(created.name);
});

async function reset(empresaId: string) {
  await db.run('DELETE FROM dot_budget_reservations WHERE empresa_id = ?', [empresaId]);
  await db.run('DELETE FROM ai_usage WHERE empresa_id = ?', [empresaId]);
}

test('PostgreSQL: a tabela do ledger e o índice único parcial existem após as migrações', async () => {
  const table = await db.get(
    `SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'dot_budget_reservations'`,
  );
  assert.ok(table, 'tabela dot_budget_reservations deve existir');
  const index = await db.get(
    `SELECT 1 AS ok FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_dot_budget_reservations_ai_usage'`,
  );
  assert.ok(index, 'índice único ux_dot_budget_reservations_ai_usage deve existir');
});

test('PostgreSQL: migrações habilitam RLS nas tabelas privadas do ledger', async () => {
  const rows = await db.all(
    `SELECT c.relname, c.relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('dot_budget_reservations', 'dot_http_idempotency')`,
  );
  assert.equal(rows.length, 2, 'as duas tabelas privadas devem existir');
  for (const row of rows) assert.equal(row.relrowsecurity, true, `RLS deve estar ativo em ${row.relname}`);
});

test('PostgreSQL: reconciliação exige ambiguidade e liquida tokens dentro da transação', async () => {
  await reset(EMPRESA);
  const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA, plan: 'rei' });
  const id = reserved.reservation!.id;

  const premature = await ledger.reconcileDotBudget({
    empresaId: EMPRESA, reservationId: id, decision: 'settle', tokens: 1500,
  });
  assert.equal(premature.ok, false);
  assert.match(String(premature.reason), /ambíguas/);
  assert.equal((await ledger.getDotReservation(EMPRESA, id))?.status, 'pending');

  const ambiguous = await ledger.finalizeDotReservation({
    empresaId: EMPRESA, reservationId: id, ambiguous: true, ambiguousReason: 'resultado incerto',
  });
  assert.equal(ambiguous.ok, true);

  const settled = await ledger.reconcileDotBudget({
    empresaId: EMPRESA, reservationId: id, decision: 'settle', tokens: 333, provider: 'groq',
  });
  assert.equal(settled.ok, true);
  assert.equal(settled.reservation?.status, 'settled');
  const usage = await db.get(
    'SELECT COUNT(*) AS c, COALESCE(SUM(tokens),0) AS t FROM ai_usage WHERE empresa_id = ? AND feature = ?',
    [EMPRESA, 'dot'],
  );
  assert.equal(Number(usage.c), 1);
  assert.equal(Number(usage.t), 333);
});


test('PostgreSQL: falha na auditoria reverte consumo e liquidação da reconciliação', async () => {
  await reset(EMPRESA);
  const audit = await import('../lib/auditLog.js');
  await audit.ensureAuditSchema(db);
  const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA, plan: 'rei' });
  assert.equal(reserved.ok, true);
  const id = reserved.reservation!.id;
  const ambiguous = await ledger.finalizeDotReservation({
    empresaId: EMPRESA,
    reservationId: id,
    ambiguous: true,
    ambiguousReason: 'resposta do provedor não confirmada',
  });
  assert.equal(ambiguous.ok, true);

  const usageBefore = await db.get(
    'SELECT COUNT(*) AS c FROM ai_usage WHERE empresa_id = ? AND feature = ?',
    [EMPRESA, 'dot'],
  );
  const auditBefore = await db.get(
    "SELECT COUNT(*) AS c FROM audit_logs WHERE empresa_id = ? AND action = 'dot.http_idempotency_reconciled'",
    [EMPRESA],
  );

  await db.run(`
    CREATE OR REPLACE FUNCTION fail_dot_reconcile_audit_test()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'simulated audit persistence failure';
    END;
    $$ LANGUAGE plpgsql
  `);
  await db.run(`
    CREATE TRIGGER fail_dot_reconcile_audit_test
    BEFORE INSERT ON audit_logs
    FOR EACH ROW
    WHEN (NEW.action = 'dot.http_idempotency_reconciled')
    EXECUTE FUNCTION fail_dot_reconcile_audit_test()
  `);

  try {
    const result = await ledger.reconcileDotBudget({
      empresaId: EMPRESA,
      reservationId: id,
      decision: 'settle',
      tokens: 456,
      provider: 'groq',
      reason: 'uso confirmado no extrato do provedor',
      audit: {
        action: 'dot.http_idempotency_reconciled',
        actorUserId: 'platform-admin-test',
        actorRole: 'admin',
        ip: '127.0.0.1',
        userAgent: 'dot-ledger-pg-test',
        detail: { idempotency_id: 123, idempotency_key_remains_blocked: true },
      },
    });
    assert.equal(result.ok, false);
    assert.equal((await ledger.getDotReservation(EMPRESA, id))?.status, 'pending');
    const usageAfter = await db.get(
      'SELECT COUNT(*) AS c FROM ai_usage WHERE empresa_id = ? AND feature = ?',
      [EMPRESA, 'dot'],
    );
    assert.equal(Number(usageAfter.c), Number(usageBefore.c));
    const auditAfter = await db.get(
      "SELECT COUNT(*) AS c FROM audit_logs WHERE empresa_id = ? AND action = 'dot.http_idempotency_reconciled'",
      [EMPRESA],
    );
    assert.equal(Number(auditAfter.c), Number(auditBefore.c));
  } finally {
    await db.run('DROP TRIGGER IF EXISTS fail_dot_reconcile_audit_test ON audit_logs');
    await db.run('DROP FUNCTION IF EXISTS fail_dot_reconcile_audit_test()');
  }
});

test('PostgreSQL: reserva e finalização gravam consumo real e liberam a reserva', async () => {
  await reset(EMPRESA);
  const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA, plan: 'rei' });
  assert.equal(reserved.ok, true);
  const finalized = await ledger.finalizeDotReservation({
    empresaId: EMPRESA,
    reservationId: reserved.reservation!.id,
    tokens: 640,
    provider: 'groq',
    tipo: 'filtra_dot_chat',
  });
  assert.equal(finalized.ok, true);
  assert.equal(finalized.reservation?.status, 'settled');
  const usage = await db.get(
    'SELECT COUNT(*) AS c, COALESCE(SUM(tokens),0) AS t FROM ai_usage WHERE empresa_id = ? AND feature = ?',
    [EMPRESA, 'dot'],
  );
  assert.equal(Number(usage.c), 1);
  assert.equal(Number(usage.t), 640);
  const snapshot = await ledger.getDotBudgetSnapshot(EMPRESA, 'rei');
  assert.equal(snapshot.used, 640);
  assert.equal(snapshot.reserved, 0);
});

test('PostgreSQL: duas instâncias finalizando a mesma reserva gravam um único consumo', async () => {
  await reset(EMPRESA);
  const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA, plan: 'rei' });
  const id = reserved.reservation!.id;
  const args = [EMPRESA, String(id), '455'];
  const results = await Promise.all([
    runNodeScript(WORKER, ['finalize', ...args], workerEnv(), WORKER_TIMEOUT_MS),
    runNodeScript(WORKER, ['finalize', ...args], workerEnv(), WORKER_TIMEOUT_MS),
  ]);
  const a = parseWorkerJson<{ ok: boolean; ai_usage_rows: number }>(results[0], 'finalize-worker-1');
  const b = parseWorkerJson<{ ok: boolean; ai_usage_rows: number }>(results[1], 'finalize-worker-2');
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const usage = await db.get(
    'SELECT COUNT(*) AS c, COALESCE(SUM(tokens),0) AS t FROM ai_usage WHERE empresa_id = ? AND feature = ?',
    [EMPRESA, 'dot'],
  );
  assert.equal(Number(usage.c), 1, 'duas instâncias não podem duplicar o consumo');
  assert.equal(Number(usage.t), 455);
});

test('PostgreSQL: reservas concorrentes são serializadas e não ultrapassam o saldo', async () => {
  await reset(EMPRESA_B);
  // Deixa saldo para exatamente uma resposta: uma reserva cabe, duas não.
  // Sem lock transacional, processos concorrentes podem ler o mesmo saldo.
  const responseLimit = ledger.dotResponseTokenLimit('rei');
  const budgetLimit = ledger.dotFeatureLimitForPlan('rei');
  const seededUsage = budgetLimit - (responseLimit * 2 - 1);
  await db.run(
    "INSERT INTO ai_usage (empresa_id, tipo, tokens, provider, feature, criado_em) VALUES (?,?,?,?,?,NOW())",
    [EMPRESA_B, 'dot_budget_seed', seededUsage, 'test', 'dot'],
  );
  const workers = await Promise.all(
    Array.from({ length: 6 }, () => runNodeScript(WORKER, ['reserve', EMPRESA_B], workerEnv(), WORKER_TIMEOUT_MS)),
  );
  const parsed = workers.map((result, index) => parseWorkerJson<{ ok: boolean; code: string | null }>(result, `reserve-worker-${index}`));
  assert.equal(parsed.filter((item) => item.ok).length, 1, 'somente uma reserva cabe no saldo restante');
  const snapshot = await ledger.getDotBudgetSnapshot(EMPRESA_B, 'rei');
  assert.equal(snapshot.used, seededUsage);
  assert.equal(snapshot.reserved, responseLimit);
  assert.ok(snapshot.used + snapshot.reserved <= snapshot.limit);
});

test('PostgreSQL: sweep e finalize concorrentes não deixam consumo órfão nem reserva reaberta', async () => {
  await reset(EMPRESA);
  const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA, plan: 'rei' });
  const id = reserved.reservation!.id;
  await db.run(
    'UPDATE dot_budget_reservations SET expires_at = ? WHERE empresa_id = ? AND id = ?',
    [new Date(Date.now() - 5_000).toISOString(), EMPRESA, id],
  );
  const [finalized] = await Promise.all([
    ledger.finalizeDotReservation({ empresaId: EMPRESA, reservationId: id, tokens: 500, provider: 'groq' }),
    ledger.sweepExpiredDotReservations({ empresaId: EMPRESA }),
    ledger.sweepExpiredDotReservations({ empresaId: EMPRESA }),
  ]);
  const row = await ledger.getDotReservation(EMPRESA, id);
  const usage = await db.get(
    'SELECT COUNT(*) AS c FROM ai_usage WHERE empresa_id = ? AND feature = ?',
    [EMPRESA, 'dot'],
  );
  assert.ok(['settled', 'expired'].includes(String(row?.status)));
  if (row?.status === 'settled') {
    assert.equal(finalized.ok, true);
    assert.equal(Number(usage.c), 1);
  } else {
    assert.equal(finalized.ok, false);
    assert.equal(Number(usage.c), 0);
  }
});

test('PostgreSQL: reserva ambígua continua comprometendo o orçamento mesmo 48h após expirar', async () => {
  await reset(EMPRESA);
  const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA, plan: 'rei' });
  const id = reserved.reservation!.id;
  await ledger.finalizeDotReservation({
    empresaId: EMPRESA,
    reservationId: id,
    ambiguous: true,
    estimatedTokens: reserved.snapshot.response_limit,
  });
  await db.run(
    'UPDATE dot_budget_reservations SET expires_at = ? WHERE empresa_id = ? AND id = ?',
    [new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), EMPRESA, id],
  );
  const swept = await ledger.sweepExpiredDotReservations({ empresaId: EMPRESA });
  assert.equal(swept.expired, 0);
  const snapshot = await ledger.getDotBudgetSnapshot(EMPRESA, 'rei');
  assert.equal(snapshot.ambiguous, reserved.snapshot.response_limit);
  assert.ok(snapshot.reserved >= reserved.snapshot.response_limit);
  const row = await ledger.getDotReservation(EMPRESA, id);
  assert.equal(row?.status, 'pending');
});
