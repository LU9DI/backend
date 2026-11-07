/**
 * Reserva ENVIADA ao provedor — corrida sweep × finalize (SQLite local).
 *
 * Regra de segurança implementada em `services/dotLedger.ts`:
 *  - reserva nunca enviada e vencida → `expired` (libera orçamento);
 *  - reserva enviada (`markDotReservationSent`) e vencida, dentro da carência
 *    (`DOT_SENT_GRACE_MS`) → NÃO expira (a geração pode estar em andamento);
 *  - reserva enviada e vencida ALÉM da carência sem finalização → `ambiguous`
 *    (o consumo é desconhecido e o orçamento fica comprometido);
 *  - reserva enviada NUNCA é liberada sem finalização — só reconciliação
 *    explícita (settle/release) encerra o compromisso.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

let sqliteAvailable = true;
try {
  await import('sqlite3');
  await import('sqlite');
} catch {
  sqliteAvailable = false;
}

const tmpDb = path.join(os.tmpdir(), `filtra-dot-sent-${Date.now()}-${process.pid}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.DOT_SENT_GRACE_MS = '60000';

const suite = sqliteAvailable ? describe : describe.skip;

const EMPRESA = 'empresa-sent-rei';

let ledger: typeof import('../services/dotLedger.js');
let db: any;

async function reset() {
  await db.run('DELETE FROM dot_budget_reservations WHERE empresa_id = ?', [EMPRESA]);
  await db.run('DELETE FROM ai_usage WHERE empresa_id = ?', [EMPRESA]);
}

async function usageCount() {
  const row = await db.get(
    'SELECT COUNT(*) AS c, COALESCE(SUM(tokens),0) AS t FROM ai_usage WHERE empresa_id = ? AND feature = ?',
    [EMPRESA, 'dot'],
  );
  return { rows: Number(row.c), tokens: Number(row.t) };
}

async function reserveAndExpire(expiresInMs: number) {
  const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA, plan: 'rei' });
  assert.equal(reserved.ok, true);
  const id = reserved.reservation!.id;
  await db.run(
    'UPDATE dot_budget_reservations SET expires_at = ? WHERE empresa_id = ? AND id = ?',
    [new Date(Date.now() + expiresInMs).toISOString(), EMPRESA, id],
  );
  return { id, responseLimit: reserved.snapshot.response_limit };
}

suite('Reserva enviada ao provedor — sweep × finalize', () => {
  before(async () => {
    const { initDB, getDb } = await import('../lib/db.js');
    await initDB();
    db = getDb();
    ledger = await import('../services/dotLedger.js');
    await ledger.ensureDotLedgerSchema();
    await reset();
  });

  after(async () => {
    try {
      const { closeDB } = await import('../lib/db.js');
      await closeDB();
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(tmpDb);
    } catch {
      /* ok */
    }
  });

  test('reserva enviada e vencida NÃO expira; orçamento continua comprometido', async () => {
    await reset();
    const { id, responseLimit } = await reserveAndExpire(-5_000);
    const marked = await ledger.markDotReservationSent({ empresaId: EMPRESA, reservationId: id });
    assert.equal(marked.ok, true);

    const swept = await ledger.sweepExpiredDotReservations({ empresaId: EMPRESA });
    assert.equal(swept.expired, 0, 'reserva enviada não pode ser expirada');

    const row = await ledger.getDotReservation(EMPRESA, id);
    assert.equal(row?.status, 'pending');
    assert.ok(row?.sent_at, 'sent_at deve estar gravado');
    const snapshot = await ledger.getDotBudgetSnapshot(EMPRESA, 'rei');
    assert.equal(snapshot.reserved, responseLimit, 'a chamada em voo continua comprometida');
    assert.equal((await usageCount()).rows, 0);
  });

  test('reserva NÃO enviada e vencida é expirada — orçamento liberado', async () => {
    await reset();
    const { id } = await reserveAndExpire(-5_000);
    const swept = await ledger.sweepExpiredDotReservations({ empresaId: EMPRESA });
    assert.equal(swept.expired, 1);
    const row = await ledger.getDotReservation(EMPRESA, id);
    assert.equal(row?.status, 'expired');
    const snapshot = await ledger.getDotBudgetSnapshot(EMPRESA, 'rei');
    assert.equal(snapshot.reserved, 0);
  });

  test('um sweep distingue abandonada de enviada na mesma passada', async () => {
    await reset();
    // Cria as duas reservas com validade futura: o próprio reserve dispara um
    // sweep, e retroagir antes da criação expiraria a primeira cedo demais.
    const abandoned = await reserveAndExpire(86_400_000);
    const sent = await reserveAndExpire(86_400_000);
    // Agora as duas estão vencidas no mesmo instante.
    const past = new Date(Date.now() - 5_000).toISOString();
    await db.run('UPDATE dot_budget_reservations SET expires_at = ? WHERE empresa_id = ?', [past, EMPRESA]);
    await ledger.markDotReservationSent({ empresaId: EMPRESA, reservationId: sent.id });

    const swept = await ledger.sweepExpiredDotReservations({ empresaId: EMPRESA });
    assert.equal(swept.expired, 1);
    assert.equal((await ledger.getDotReservation(EMPRESA, abandoned.id))?.status, 'expired');
    assert.equal((await ledger.getDotReservation(EMPRESA, sent.id))?.status, 'pending');
  });

  test('dentro da carência a reserva enviada não vira ambígua', async () => {
    await reset();
    const { id } = await reserveAndExpire(-5_000);
    await ledger.markDotReservationSent({ empresaId: EMPRESA, reservationId: id });
    const swept = await ledger.sweepExpiredDotReservations({ empresaId: EMPRESA });
    assert.equal(swept.ambiguous_marked, 0);
    const row = await ledger.getDotReservation(EMPRESA, id);
    assert.equal(row?.status, 'pending');
    assert.equal(Number(row?.ambiguous), 0);
  });

  test('além da carência, reserva enviada sem finalização vira ambígua e mantém o orçamento', async () => {
    await reset();
    const { id, responseLimit } = await reserveAndExpire(-5_000);
    await db.run(
      'UPDATE dot_budget_reservations SET sent_at = ? WHERE empresa_id = ? AND id = ?',
      [new Date(Date.now() - 5 * 60_000).toISOString(), EMPRESA, id],
    );
    const swept = await ledger.sweepExpiredDotReservations({ empresaId: EMPRESA });
    assert.equal(swept.ambiguous_marked, 1);
    assert.equal(swept.expired, 0);

    const row = await ledger.getDotReservation(EMPRESA, id);
    assert.equal(row?.status, 'pending');
    assert.equal(Number(row?.ambiguous), 1);

    // Idempotente: a segunda varredura não remarca.
    const again = await ledger.sweepExpiredDotReservations({ empresaId: EMPRESA });
    assert.equal(again.ambiguous_marked, 0);

    const snapshot = await ledger.getDotBudgetSnapshot(EMPRESA, 'rei');
    assert.equal(snapshot.ambiguous, responseLimit);
    assert.equal((await usageCount()).rows, 0);
  });

  test('sweep × sweep concorrentes: a abandonada expira uma única vez', async () => {
    await reset();
    const { id } = await reserveAndExpire(-5_000);
    const [a, b] = await Promise.all([
      ledger.sweepExpiredDotReservations({ empresaId: EMPRESA }),
      ledger.sweepExpiredDotReservations({ empresaId: EMPRESA }),
    ]);
    assert.equal(a.expired + b.expired, 1, 'as duas varreduras não podem contar a mesma reserva');
    assert.equal((await ledger.getDotReservation(EMPRESA, id))?.status, 'expired');
  });

  test('sweep × finalize em reserva enviada: finalize vence e o consumo é único', async () => {
    await reset();
    const { id } = await reserveAndExpire(-5_000);
    await ledger.markDotReservationSent({ empresaId: EMPRESA, reservationId: id });

    const [finalized] = await Promise.all([
      ledger.finalizeDotReservation({ empresaId: EMPRESA, reservationId: id, tokens: 432, provider: 'groq' }),
      ledger.sweepExpiredDotReservations({ empresaId: EMPRESA }),
      ledger.sweepExpiredDotReservations({ empresaId: EMPRESA }),
    ]);

    const row = await ledger.getDotReservation(EMPRESA, id);
    assert.equal(row?.status, 'settled', 'reserva enviada não pode ser liberada pela varredura');
    assert.equal(finalized.ok, true);
    const usage = await usageCount();
    assert.equal(usage.rows, 1);
    assert.equal(usage.tokens, 432);
  });

  test('reserva enviada continua liquidável após virar ambígua (consumo real único)', async () => {
    await reset();
    const { id } = await reserveAndExpire(-5_000);
    await db.run(
      'UPDATE dot_budget_reservations SET sent_at = ? WHERE empresa_id = ? AND id = ?',
      [new Date(Date.now() - 5 * 60_000).toISOString(), EMPRESA, id],
    );
    await ledger.sweepExpiredDotReservations({ empresaId: EMPRESA });

    const finalized = await ledger.finalizeDotReservation({
      empresaId: EMPRESA,
      reservationId: id,
      tokens: 350,
      provider: 'groq',
      tipo: 'filtra_dot_chat',
    });
    assert.equal(finalized.ok, true);
    const usage = await usageCount();
    assert.equal(usage.rows, 1);
    assert.equal(usage.tokens, 350);
  });

  test('marca de envio é idempotente e sobrevive à finalização', async () => {
    await reset();
    const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA, plan: 'rei' });
    const id = reserved.reservation!.id;
    const first = await ledger.markDotReservationSent({ empresaId: EMPRESA, reservationId: id });
    const second = await ledger.markDotReservationSent({ empresaId: EMPRESA, reservationId: id });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.reservation?.sent_at, second.reservation?.sent_at, 'a marca é estável');

    await ledger.finalizeDotReservation({ empresaId: EMPRESA, reservationId: id, tokens: 210, provider: 'groq' });
    const row = await ledger.getDotReservation(EMPRESA, id);
    assert.ok(row?.sent_at, 'settled mantém o registro de quando a chamada saiu');
    assert.equal(row?.status, 'settled');
  });
});
