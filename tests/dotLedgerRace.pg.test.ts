/**
 * Regressão PostgreSQL da corrida `sweepExpiredDotReservations` × `finalizeDotReservation`.
 *
 * Roda apenas em `npm run test:postgres` (exige DATABASE_URL descartável e cria
 * um banco temporário próprio, derrubado no `finally`).
 *
 * Cobre:
 *  1. finalize vence a corrida e sweep não altera `settled`;
 *  2. sweep vence a corrida e finalize não declara sucesso falso;
 *  3. nenhuma linha de consumo órfã;
 *  4. nenhuma duplicação de `ai_usage`;
 *  5. repetição de finalize liquidado continua idempotente;
 *  6. tenant diferente não consegue afetar a reserva;
 *  7. reservas enviadas (`sent_at`) não são expiradas.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { createTestDatabase, dropTestDatabase } from './helpers/pg-test-utils.js';

let created: { name: string; url: string } | null = null;
let db: any;
let ledger: typeof import('../services/dotLedger.js');

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL de teste PostgreSQL é obrigatória');
  process.env.NODE_ENV = 'test';
  created = await createTestDatabase('filtra_dot_race');
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

function tenant(): string {
  return `pg-race-${crypto.randomUUID()}`;
}

/** Cria uma reserva já vencida (expires_at no passado) para o tenant. */
async function reserveExpired(empresaId: string): Promise<{ id: number }> {
  const reserved = await ledger.reserveDotExecution({ empresaId, plan: 'rei' });
  assert.ok(reserved.reservation, 'reserva não criada');
  const id = reserved.reservation.id;
  await db.run(
    'UPDATE dot_budget_reservations SET expires_at = ? WHERE empresa_id = ? AND id = ?',
    [new Date(Date.now() - 5_000).toISOString(), empresaId, id],
  );
  return { id };
}

async function usageCount(empresaId: string): Promise<number> {
  const row = await db.get(
    'SELECT COUNT(*) AS c FROM ai_usage WHERE empresa_id = ? AND feature = ?',
    [empresaId, 'dot'],
  );
  return Number(row.c);
}

async function rowOf(empresaId: string, id: number): Promise<any> {
  return db.get('SELECT * FROM dot_budget_reservations WHERE empresa_id = ? AND id = ?', [empresaId, id]);
}

function setGrace(value: string | undefined): void {
  if (value === undefined) delete process.env.DOT_SENT_GRACE_MS;
  else process.env.DOT_SENT_GRACE_MS = value;
}

test('PG race 1: finalize vence e sweep posterior não altera settled', async () => {
  const empresaId = tenant();
  const { id } = await reserveExpired(empresaId);
  const fin = await ledger.finalizeDotReservation({ empresaId, reservationId: id, tokens: 500, provider: 'groq' });
  assert.equal(fin.ok, true, 'finalize deve liquidar a reserva vencida');
  const swept = await ledger.sweepExpiredDotReservations({ empresaId });
  assert.equal(swept.expired, 0, 'sweep não pode expirar reserva já liquidada');
  const row = await rowOf(empresaId, id);
  assert.equal(String(row.status), 'settled');
  assert.equal(await usageCount(empresaId), 1);
});

test('PG race 2/3/4: finalize × 2 sweeps concorrentes nunca geram consumo órfão nem settled→expired', async () => {
  for (let iter = 0; iter < 8; iter++) {
    const empresaId = tenant();
    const { id } = await reserveExpired(empresaId);
    const [fin] = await Promise.all([
      ledger.finalizeDotReservation({ empresaId, reservationId: id, tokens: 500, provider: 'groq' }),
      ledger.sweepExpiredDotReservations({ empresaId }),
      ledger.sweepExpiredDotReservations({ empresaId }),
    ]);
    const row = await rowOf(empresaId, id);
    const status = String(row?.status);
    const usage = await usageCount(empresaId);
    assert.ok(['settled', 'expired'].includes(status), `iter ${iter}: status inesperado ${status}`);
    if (status === 'settled') {
      assert.equal(fin.ok, true, `iter ${iter}: settled exige finalize ok`);
      assert.equal(usage, 1, `iter ${iter}: settled exige exatamente 1 consumo`);
      assert.ok(row.ai_usage_id !== null && row.ai_usage_id !== undefined, `iter ${iter}: settled exige ai_usage_id`);
    } else {
      assert.equal(fin.ok, false, `iter ${iter}: expired não pode declarar sucesso`);
      assert.equal(usage, 0, `iter ${iter}: expired não pode ter consumo (órfão)`);
      assert.ok(row.ai_usage_id === null || row.ai_usage_id === undefined, `iter ${iter}: expired não pode ter ai_usage_id`);
    }
  }
});

test('PG race 2: sweep vence e finalize não declara sucesso falso', async () => {
  const empresaId = tenant();
  const { id } = await reserveExpired(empresaId);
  const swept = await ledger.sweepExpiredDotReservations({ empresaId });
  assert.equal(swept.expired, 1);
  const fin = await ledger.finalizeDotReservation({ empresaId, reservationId: id, tokens: 500, provider: 'groq' });
  assert.equal(fin.ok, false, 'finalize sobre reserva expirada deve falhar');
  const row = await rowOf(empresaId, id);
  assert.equal(String(row.status), 'expired');
  assert.equal(await usageCount(empresaId), 0);
});

test('PG race 4: dois finalizes concorrentes gravam um único consumo', async () => {
  const empresaId = tenant();
  const { id } = await reserveExpired(empresaId);
  const [a, b] = await Promise.all([
    ledger.finalizeDotReservation({ empresaId, reservationId: id, tokens: 500, provider: 'groq' }),
    ledger.finalizeDotReservation({ empresaId, reservationId: id, tokens: 500, provider: 'groq' }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(await usageCount(empresaId), 1, 'não pode duplicar ai_usage');
  assert.equal(String((await rowOf(empresaId, id)).status), 'settled');
});

test('PG race 5: repetir finalize liquidado continua idempotente', async () => {
  const empresaId = tenant();
  const { id } = await reserveExpired(empresaId);
  const first = await ledger.finalizeDotReservation({ empresaId, reservationId: id, tokens: 500, provider: 'groq' });
  assert.equal(first.ok, true);
  const second = await ledger.finalizeDotReservation({ empresaId, reservationId: id, tokens: 999, provider: 'groq' });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(await usageCount(empresaId), 1, 'repetição não pode criar novo consumo');
  const row = await rowOf(empresaId, id);
  assert.equal(String(row.status), 'settled');
  assert.equal(Number(row.tokens_real), 500, 'repetição não pode alterar o consumo já liquidado');
});

test('PG race 6: outro tenant não consegue afetar a reserva', async () => {
  const empresaId = tenant();
  const outro = tenant();
  const { id } = await reserveExpired(empresaId);
  const fin = await ledger.finalizeDotReservation({ empresaId: outro, reservationId: id, tokens: 500, provider: 'groq' });
  assert.equal(fin.ok, false, 'tenant errado não pode liquidar');
  const swept = await ledger.sweepExpiredDotReservations({ empresaId: outro });
  assert.equal(swept.expired, 0, 'tenant errado não pode expirar');
  const row = await rowOf(empresaId, id);
  assert.equal(String(row.status), 'pending');
  assert.equal(await usageCount(empresaId), 0);
  const visible = await ledger.getDotReservation(outro, id);
  assert.equal(visible, null, 'reserva não pode vazar para outro tenant');
});

test('PG race 7: reserva enviada (sent_at) não é expirada; vira ambígua após a carência', async () => {
  const empresaId = tenant();
  const { id } = await reserveExpired(empresaId);
  const sentAt = new Date(Date.now() - 1_000).toISOString();
  await db.run(
    'UPDATE dot_budget_reservations SET sent_at = ? WHERE empresa_id = ? AND id = ?',
    [sentAt, empresaId, id],
  );

  const prev = process.env.DOT_SENT_GRACE_MS;
  try {
    // Carência de 1h: enviada há 1s ainda não pode ser expirada nem marcada ambígua.
    setGrace(String(60 * 60_000));
    const withinGrace = await ledger.sweepExpiredDotReservations({ empresaId });
    assert.equal(withinGrace.expired, 0);
    assert.equal(withinGrace.ambiguous_marked, 0);
    assert.equal(String((await rowOf(empresaId, id)).status), 'pending');

    // Carência vencida: vira ambígua (NUNCA expirada).
    setGrace('0');
    const afterGrace = await ledger.sweepExpiredDotReservations({ empresaId });
    assert.equal(afterGrace.expired, 0, 'reserva enviada jamais é expirada');
    assert.equal(afterGrace.ambiguous_marked, 1);
    const row = await rowOf(empresaId, id);
    assert.equal(String(row.status), 'pending');
    assert.equal(Number(row.ambiguous), 1);

    // Finalize depois de ambígua também não inventa sucesso nem consumo.
    const fin = await ledger.finalizeDotReservation({ empresaId, reservationId: id, tokens: 500, provider: 'groq' });
    assert.equal(fin.ok, true, 'ambígua ainda está pending e pode ser liquidada pela reconciliação');
    assert.equal(await usageCount(empresaId), 1);
  } finally {
    setGrace(prev);
  }
});
