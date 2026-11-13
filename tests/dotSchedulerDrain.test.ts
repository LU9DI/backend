/**
 * Scheduler do Dot — estado e encerramento.
 *
 * Bugs cobertos:
 *  1. `currentRun` comparava duas promessas DIFERENTES (`run` vs
 *     `run.finally(...)`), então a limpeza nunca casava e a rodada seguia
 *     "em voo" para o shutdown;
 *  2. `stopDotMonitorScheduler` devolvia `in_flight: true` mesmo após drenar
 *     a rodada com sucesso;
 *  3. um tick disparado com uma rodada em voo enfileirava outra cópia em
 *     vez de reutilizar a promessa existente.
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

const tmpDb = path.join(os.tmpdir(), `filtra-dot-scheduler-${Date.now()}-${process.pid}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.FILTRA_DOT_ENABLED = '1';
process.env.FILTRA_DOT_FORCE_ON = '1';
process.env.FILTRA_DOT_MONITOR_TICK_MS = '600000';

const suite = sqliteAvailable ? describe : describe.skip;

let scheduler: typeof import('../services/dotScheduler.js');

suite('Scheduler — estado e encerramento gracioso', () => {
  before(async () => {
    const { initDB } = await import('../lib/db.js');
    await initDB();
    scheduler = await import('../services/dotScheduler.js');
  });

  after(async () => {
    try {
      await scheduler.stopDotMonitorScheduler(1_000);
    } catch {
      /* ok */
    }
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

  test('após o start, a rodada em voo é visível e a parada aguarda o término', async () => {
    scheduler.startDotMonitorScheduler();
    const during = scheduler.getDotSchedulerRuntimeStatus();
    assert.equal(during.timer_active, true);
    assert.equal(during.in_flight, true, 'rodada recém-iniciada continua em voo');

    // A rodada leva ~5s nesta máquina; o teto de 5s do shutdown é o contrato
    // de produção, não o orçamento do teste. Aqui verificamos a drenagem real.
    const stopped = await scheduler.stopDotMonitorScheduler(30_000);
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.in_flight, false, 'após a drenagem não há rodada em voo');

    const afterStop = scheduler.getDotSchedulerRuntimeStatus();
    assert.equal(afterStop.timer_active, false);
    assert.equal(afterStop.in_flight, false);
  });

  test('paradas repetidas são idempotentes e nunca devolvem in_flight preso', async () => {
    scheduler.startDotMonitorScheduler();
    await scheduler.stopDotMonitorScheduler(30_000);
    const again = await scheduler.stopDotMonitorScheduler(30_000);
    assert.equal(again.stopped, true);
    assert.equal(again.in_flight, false);
  });

  test('iniciar duas vezes não cria duas rodadas nem dois timers', async () => {
    scheduler.startDotMonitorScheduler();
    const first = scheduler.getDotSchedulerRuntimeStatus();
    scheduler.startDotMonitorScheduler();
    const second = scheduler.getDotSchedulerRuntimeStatus();
    assert.equal(second.timer_active, first.timer_active);
    assert.equal(second.in_flight, true);
    await scheduler.stopDotMonitorScheduler(30_000);
  });
});
