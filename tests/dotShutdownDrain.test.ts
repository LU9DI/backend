/**
 * Shutdown COMPORTAMENTAL: drenagem real e ausência de consultas após o
 * fechamento do pool.
 *
 * A verificação da ordem no texto de `server.ts` não basta (é só estrutura).
 * Este teste executa o ciclo de verdade:
 *
 *   1. um worker com trabalho em andamento consulta o banco;
 *   2. a parada é solicitada;
 *   3. a drenagem espera o tick terminar;
 *   4. o pool é fechado (`closeDB`);
 *   5. nenhuma consulta acontece depois — um espião conta cada operação e
 *      falha se houver qualquer uma após o fechamento.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

const tmpDb = path.join(os.tmpdir(), `filtra-dot-drain-${Date.now()}-${process.pid}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.DOT_AGENT_WORKER_ENABLED = '1';
process.env.DOT_AGENT_WORKER_INTERVAL_MS = '60000';
process.env.FILTRA_DOT_ENABLED = '1';
process.env.FILTRA_DOT_FORCE_ON = '1';
process.env.FILTRA_DOT_MONITOR_TICK_MS = '60000';

const suite = sqliteAvailable ? describe : describe.skip;

let db: any;
let worker: typeof import('../services/dotAgentWorker.js');
let scheduler: typeof import('../services/dotScheduler.js');
let closeDB: () => Promise<void>;

const EMPRESA = `drain-${crypto.randomUUID()}`;

type Spy = { operations: number; afterClose: number; closed: boolean };

/** Instala o espião nas operações do banco. */
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

suite('Shutdown comportamental — drenagem antes do fechamento do pool', () => {
  before(async () => {
    const mod = await import('../lib/db.js');
    await mod.initDB();
    db = mod.getDb();
    closeDB = mod.closeDB;
    worker = await import('../services/dotAgentWorker.js');
    scheduler = await import('../services/dotScheduler.js');

    const { ensureDotAgentSchema } = await import('../services/dotAgent.js');
    const { ensureMissionTables } = await import('../services/dotAgentMissions.js');
    await ensureDotAgentSchema();
    await ensureMissionTables();

    await db.run(
      'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
      [EMPRESA, 'cnpjdrain000001', 'Empresa Drain', `slug-${EMPRESA.slice(-8)}`, 'ativo', 'rei',
        new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString()],
    );
  });

  after(async () => {
    try {
      await worker.stopDotAgentWorkerAndDrain(1_000);
      await scheduler.stopDotMonitorScheduler(1_000);
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(tmpDb);
    } catch {
      /* ok */
    }
  });

  test('worker em execução é drenado e nenhuma consulta ocorre após o fechamento do pool', async () => {
    const spy = installSpy(db);

    // 1. Worker ligado: o start dispara um tick imediato que consulta o banco.
    worker.startDotAgentWorker();
    const tick = worker.wakeDotAgentWorker();
    assert.ok(tick, 'o worker precisa expor o tick em andamento');
    await tick;
    const duringTick = spy.operations;
    assert.ok(duringTick > 0, 'o tick precisa consultar o banco (prova de que havia trabalho em voo)');

    // 2. Solicitação de parada + 3. drenagem: aguarda o tick terminar.
    const drained = await worker.stopDotAgentWorkerAndDrain(5_000);
    assert.equal(drained.drained, true, 'a drenagem precisa concluir dentro do teto');
    assert.equal(worker.getDotAgentWorkerStatus().timer_active, false);

    // Depois da drenagem o worker não pode mais tocar o banco por conta própria.
    const afterDrain = spy.operations;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(spy.operations, afterDrain, 'worker drenado não pode continuar consultando o banco');

    // 4. Fechamento do pool.
    spy.closed = true;
    await closeDB();

    // 5. Nenhuma operação depois do fechamento.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      spy.afterClose,
      0,
      `${spy.afterClose} operação(ões) de banco ocorreram depois de closeDB()`,
    );
  });

  test('scheduler parado não consulta o banco depois da drenagem', async () => {
    // O pool já foi fechado no teste anterior: reconecta para este cenário.
    const mod = await import('../lib/db.js');
    await mod.initDB();
    db = mod.getDb();
    const spy = installSpy(db);

    scheduler.startDotMonitorScheduler();
    // A rodada leva ~5s nesta máquina; o teto de 5s do shutdown é o contrato
    // de produção, não o orçamento do teste. Aqui verificamos a drenagem real.
    await scheduler.stopDotMonitorScheduler(30_000);
    const afterStop = spy.operations;

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(spy.operations, afterStop, 'scheduler parado não pode iniciar nova rodada');

    spy.closed = true;
    await mod.closeDB();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(spy.afterClose, 0, 'nenhuma consulta pode acontecer após o fechamento');
  });

  test('a drenagem é limitada no tempo e não pendura o processo', async () => {
    const mod = await import('../lib/db.js');
    await mod.initDB();
    const startedAt = Date.now();
    const result = await worker.stopDotAgentWorkerAndDrain(50);
    const elapsed = Date.now() - startedAt;
    assert.equal(typeof result.drained, 'boolean');
    assert.ok(elapsed < 5_000, `a drenagem levou ${elapsed}ms`);
    await mod.closeDB();
  });
});
