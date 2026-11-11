/**
 * Regressão da invariante de boot do Dot:
 *
 *   nenhum timer de scheduler ou worker pode rodar sem `FILTRA_DOT_ENABLED=1`;
 *   o monitor exige adicionalmente `FILTRA_DOT_FORCE_ON=1`.
 *
 * O servidor já monta as rotas e inicia os timers apenas dentro do bloco do
 * Dot; estes testes cobrem a segunda barreira (chamada direta/regressão de
 * wiring), que é o modo pelo qual um timer poderia escapar do gate.
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

const tmpDb = path.join(os.tmpdir(), `filtra-dot-timer-gates-${Date.now()}-${process.pid}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = tmpDb;
delete process.env.FILTRA_DOT_ENABLED;
delete process.env.FILTRA_DOT_FORCE_ON;
delete process.env.DOT_AGENT_WORKER_ENABLED;
delete process.env.FILTRA_DOT_MONITOR_TICK_MS;
delete process.env.DOT_AGENT_WORKER_INTERVAL_MS;

const suite = sqliteAvailable ? describe : describe.skip;

type Scheduler = typeof import('../services/dotScheduler.js');
type Worker = typeof import('../services/dotAgentWorker.js');

let scheduler: Scheduler;
let worker: Worker;

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...values } as NodeJS.ProcessEnv;
}

async function stopAll(): Promise<void> {
  await scheduler?.stopDotMonitorScheduler(5_000).catch(() => undefined);
  await worker?.stopDotAgentWorkerAndDrain(5_000).catch(() => undefined);
}

suite('Dot — timers só iniciam com as flags explícitas', () => {
  before(async () => {
    const { initDB } = await import('../lib/db.js');
    await initDB();
    scheduler = await import('../services/dotScheduler.js');
    worker = await import('../services/dotAgentWorker.js');
  });

  after(async () => {
    await stopAll();
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

  test('predicado do scheduler exige FILTRA_DOT_ENABLED e FILTRA_DOT_FORCE_ON', () => {
    assert.equal(scheduler.dotSchedulerRuntimeEnabled(env({})), false);
    assert.equal(scheduler.dotSchedulerRuntimeEnabled(env({ FILTRA_DOT_ENABLED: '1' })), false);
    assert.equal(scheduler.dotSchedulerRuntimeEnabled(env({ FILTRA_DOT_FORCE_ON: '1' })), false);
    assert.equal(
      scheduler.dotSchedulerRuntimeEnabled(env({ FILTRA_DOT_ENABLED: '1', FILTRA_DOT_FORCE_ON: '1' })),
      true,
    );
  });

  test('predicado do worker exige FILTRA_DOT_ENABLED e respeita DOT_AGENT_WORKER_ENABLED=0', () => {
    assert.equal(worker.dotWorkerRuntimeEnabled(env({})), false);
    assert.equal(worker.dotWorkerRuntimeEnabled(env({ DOT_AGENT_WORKER_ENABLED: '1' })), false);
    assert.equal(worker.dotWorkerRuntimeEnabled(env({ FILTRA_DOT_ENABLED: '1' })), true);
    assert.equal(
      worker.dotWorkerRuntimeEnabled(env({ FILTRA_DOT_ENABLED: '1', DOT_AGENT_WORKER_ENABLED: '0' })),
      false,
    );
  });

  test('scheduler não cria timer sem flags e nem com apenas FORCE_ON', async () => {
    delete process.env.FILTRA_DOT_ENABLED;
    delete process.env.FILTRA_DOT_FORCE_ON;
    scheduler.startDotMonitorScheduler();
    assert.equal(scheduler.getDotSchedulerRuntimeStatus().timer_active, false);

    process.env.FILTRA_DOT_FORCE_ON = '1';
    scheduler.startDotMonitorScheduler();
    assert.equal(scheduler.getDotSchedulerRuntimeStatus().timer_active, false);
    delete process.env.FILTRA_DOT_FORCE_ON;
  });

  test('worker não cria timer com o Dot desabilitado', async () => {
    delete process.env.FILTRA_DOT_ENABLED;
    process.env.DOT_AGENT_WORKER_ENABLED = '1';
    worker.startDotAgentWorker();
    assert.equal(worker.getDotAgentWorkerStatus().timer_active, false);
  });

  test('scheduler inicia com as duas flags e a parada drena', async () => {
    process.env.FILTRA_DOT_ENABLED = '1';
    process.env.FILTRA_DOT_FORCE_ON = '1';
    process.env.FILTRA_DOT_MONITOR_TICK_MS = '600000';
    scheduler.startDotMonitorScheduler();
    assert.equal(scheduler.getDotSchedulerRuntimeStatus().timer_active, true);

    const stopped = await scheduler.stopDotMonitorScheduler(30_000);
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.in_flight, false);
    assert.equal(scheduler.getDotSchedulerRuntimeStatus().timer_active, false);
  });

  test('worker inicia com o Dot habilitado e a parada drena', async () => {
    process.env.FILTRA_DOT_ENABLED = '1';
    delete process.env.DOT_AGENT_WORKER_ENABLED;
    process.env.DOT_AGENT_WORKER_INTERVAL_MS = '600000';
    worker.startDotAgentWorker();
    assert.equal(worker.getDotAgentWorkerStatus().timer_active, true);

    await worker.stopDotAgentWorkerAndDrain(30_000);
    assert.equal(worker.getDotAgentWorkerStatus().timer_active, false);
  });
});
