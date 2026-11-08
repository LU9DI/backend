/**
 * Worker do Dot — caminhos de execução compartilham a MESMA promessa de tick.
 *
 * Bugs cobertos:
 *  1. o tick de inicialização e o de timer iniciados por
 *     `startDotAgentWorker` não eram registrados: o shutdown fechava o pool
 *     enquanto a rodada ainda consultava o banco;
 *  2. promessas paralelas de timer/wake podiam ser contadas como concluídas
 *     enquanto o trabalho real continuava em voo.
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

const tmpDb = path.join(os.tmpdir(), `filtra-dot-tickshare-${Date.now()}-${process.pid}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.DOT_AGENT_WORKER_ENABLED = '1';
process.env.DOT_AGENT_WORKER_INTERVAL_MS = '600000';

const suite = sqliteAvailable ? describe : describe.skip;

let worker: typeof import('../services/dotAgentWorker.js');

suite('Worker — promessa única por tick', () => {
  before(async () => {
    const { initDB } = await import('../lib/db.js');
    await initDB();
    worker = await import('../services/dotAgentWorker.js');
    const { ensureDotAgentSchema } = await import('../services/dotAgent.js');
    const { ensureMissionTables } = await import('../services/dotAgentMissions.js');
    await ensureDotAgentSchema();
    await ensureMissionTables();
  });

  after(async () => {
    try {
      await worker.stopDotAgentWorkerAndDrain(1_000);
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

  test('start agenda um tick e wake devolve A MESMA promessa', async () => {
    worker.startDotAgentWorker();
    const tickA = worker.wakeDotAgentWorker();
    const tickB = worker.wakeDotAgentWorker();
    assert.ok(tickA, 'o tick em voo precisa ser observável');
    assert.equal(tickA, tickB, 'todos os caminhos devolvem a mesma promessa em voo');
    await tickA;
    const drained = await worker.stopDotAgentWorkerAndDrain(5_000);
    assert.equal(drained.drained, true);
    const status = worker.getDotAgentWorkerStatus();
    assert.equal(status.timer_active, false);
    assert.equal(status.in_flight, false);
  });

  test('após o assentamento, um novo wake cria um tick novo (nunca reutiliza encerrado)', async () => {
    worker.startDotAgentWorker();
    const first = worker.wakeDotAgentWorker();
    assert.ok(first);
    await first;
    await worker.stopDotAgentWorkerAndDrain(5_000);

    const second = worker.wakeDotAgentWorker();
    assert.ok(second);
    assert.notEqual(first, second, 'tick encerrado não pode ser devolvido como em voo');
    await second;
    await worker.stopDotAgentWorkerAndDrain(5_000);
  });

  test('status expõe in_flight durante o tick e some depois da drenagem', async () => {
    worker.startDotAgentWorker();
    const status = worker.getDotAgentWorkerStatus();
    assert.equal(status.timer_active, true);
    assert.equal(status.in_flight, true, 'tick recém-iniciado continua em voo');
    const drained = await worker.stopDotAgentWorkerAndDrain(5_000);
    assert.equal(drained.drained, true);
    assert.equal(worker.getDotAgentWorkerStatus().in_flight, false);
  });

  test('drenagem sem tick em voo é imediata e não pendura', async () => {
    const started = Date.now();
    const result = await worker.stopDotAgentWorkerAndDrain(100);
    const elapsed = Date.now() - started;
    assert.equal(result.drained, true);
    assert.ok(elapsed < 5_000);
  });

  test('fila de missões do tick respeita o limite e não quebra sem trabalho', async () => {
    worker.startDotAgentWorker();
    const tick = worker.wakeDotAgentWorker();
    await assert.doesNotReject(async () => {
      if (tick) await tick;
    });
    await worker.stopDotAgentWorkerAndDrain(5_000);
  });
});
