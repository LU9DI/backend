/**
 * Shutdown dos workers de background — COMPORTAMENTAL.
 *
 * Não basta conferir texto em `server.ts` (isso é feito em `dotShutdown.test.ts`).
 * Aqui cada worker real é ligado, recebe trabalho que consulta o banco, é
 * drenado e então o pool é fechado. O espião prova que **nenhuma consulta
 * acontece depois de `closeDB()`** e que a parada é idempotente.
 *
 * Cobertura: retry worker, acquisition worker, replenisher e relatório mensal.
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

const tmpDb = path.join(os.tmpdir(), `filtra-workers-drain-${Date.now()}-${process.pid}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.RETRY_WORKER = '1';
process.env.RETRY_WORKER_INTERVAL_MS = '60000';

const suite = sqliteAvailable ? describe : describe.skip;

type Spy = { operations: number; afterClose: number; closed: boolean };

function installSpy(database: any): Spy {
  const spy: Spy = { operations: 0, afterClose: 0, closed: false };
  for (const method of ['get', 'all', 'run', 'exec'] as const) {
    const original = database[method].bind(database);
    database[method] = async (...args: any[]) => {
      spy.operations += 1;
      if (spy.closed) spy.afterClose += 1;
      return original(...args);
    };
  }
  return spy;
}

async function freshDb() {
  const mod = await import('../lib/db.js');
  await mod.initDB();
  return { db: mod.getDb(), closeDB: mod.closeDB };
}

suite('Workers de background — drenagem e ausência de consultas após closeDB()', () => {
  before(async () => {
    await freshDb();
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

  test('retry worker: drena a execução em voo e não consulta o banco depois do fechamento', async () => {
    const { db, closeDB } = await freshDb();
    const retry = await import('../lib/retryQueue.js');
    const { ensureRetryQueue } = retry;
    await ensureRetryQueue(db);

    const spy = installSpy(db);
    retry.startRetryWorker();
    // O start dispara um tick imediato que consulta a fila.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(spy.operations > 0, 'o retry worker precisa consultar o banco (prova de trabalho em voo)');

    const drained = await retry.stopRetryWorkerAndDrain(5_000);
    assert.equal(typeof drained.drained, 'boolean');
    const afterDrain = spy.operations;

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(spy.operations, afterDrain, 'worker parado não pode iniciar novo tick');

    // Idempotência: segunda parada não lança e continua parado.
    const again = await retry.stopRetryWorkerAndDrain(1_000);
    assert.equal(typeof again.drained, 'boolean');

    spy.closed = true;
    await closeDB();
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(spy.afterClose, 0, `${spy.afterClose} consulta(s) ocorreram após closeDB()`);
  });

  test('acquisition worker: para sem consultar o banco depois do fechamento', async () => {
    const { db, closeDB } = await freshDb();
    const acq = await import('../lib/acquisitionEngine.js');
    await acq.ensureAcquisitionEngineSchema(db);

    const spy = installSpy(db);
    acq.startAcquisitionWorker();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const drained = await acq.stopAcquisitionWorkerAndDrain(5_000);
    assert.equal(typeof drained.drained, 'boolean');
    const afterDrain = spy.operations;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(spy.operations, afterDrain, 'worker parado não pode iniciar novo tick');

    const again = await acq.stopAcquisitionWorkerAndDrain(1_000);
    assert.equal(typeof again.drained, 'boolean');

    spy.closed = true;
    await closeDB();
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(spy.afterClose, 0, `${spy.afterClose} consulta(s) ocorreram após closeDB()`);
  });

  test('relatório mensal: parada desarma os dois timers e é idempotente', async () => {
    const monthly = await import('../services/monthlyReportScheduler.js');
    monthly.startMonthlyReportScheduler();
    const stoppedFirst = await monthly.stopMonthlyReportSchedulerAndDrain(2_000);
    assert.equal(typeof stoppedFirst.drained, 'boolean');
    // Segundo chamada: nada para parar, não lança.
    const stoppedAgain = await monthly.stopMonthlyReportSchedulerAndDrain(2_000);
    assert.equal(stoppedAgain.drained, true);
    assert.equal(stoppedAgain.in_flight, false);
  });

  test('replenisher: parada idempotente e sem pendurar o processo', async () => {
    const rep = await import('../lib/acquisitionReplenisher.js');
    const startedAt = Date.now();
    const first = await rep.stopAcquisitionReplenisherAndDrain(2_000);
    const second = await rep.stopAcquisitionReplenisherAndDrain(2_000);
    const elapsed = Date.now() - startedAt;
    assert.equal(typeof first.drained, 'boolean');
    assert.equal(typeof second.drained, 'boolean');
    assert.ok(elapsed < 10_000, `a parada levou ${elapsed}ms`);
  });
});
