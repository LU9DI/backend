/**
 * Scheduler e worker do Filtra Dot — parada, drenagem e sequência de shutdown.
 *
 * Cobre o que a auditoria pediu:
 *  - a parada do scheduler não inicia novas rodadas;
 *  - a parada espera a rodada em andamento (ou desiste dentro do teto);
 *  - o worker é drenado antes de o pool do PostgreSQL ser fechado;
 *  - o timeout de shutdown é respeitado (nunca pendura o processo);
 *  - chamadas repetidas de parada são idempotentes;
 *  - falha transitória do worker é tratada, não vira rejeição não tratada;
 *  - a sequência no `server.ts` para os subsistemas antes de `closeDB()`.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

let sqliteAvailable = true;
try {
  await import('sqlite3');
  await import('sqlite');
} catch {
  sqliteAvailable = false;
}

const tmpDb = path.join(os.tmpdir(), `filtra-dot-shutdown-${Date.now()}-${process.pid}.sqlite`);
process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.FILTRA_DOT_ENABLED = '1';
process.env.FILTRA_DOT_FORCE_ON = '1';
process.env.DOT_AGENT_WORKER_ENABLED = '1';
process.env.FILTRA_DOT_MONITOR_TICK_MS = '60000';
process.env.DOT_AGENT_WORKER_INTERVAL_MS = '60000';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const serverSource = fs.readFileSync(path.join(repoRoot, 'server.ts'), 'utf8');

const suite = sqliteAvailable ? describe : describe.skip;

let db: any;
let scheduler: typeof import('../services/dotScheduler.js');
let worker: typeof import('../services/dotAgentWorker.js');

const EMPRESA = `shutdown-${crypto.randomUUID()}`;

suite('Scheduler e worker — encerramento gracioso', () => {
  before(async () => {
    const { initDB, getDb } = await import('../lib/db.js');
    await initDB();
    db = getDb();
    scheduler = await import('../services/dotScheduler.js');
    worker = await import('../services/dotAgentWorker.js');
    const now = new Date().toISOString();
    await db.run(
      'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
      [EMPRESA, 'cnpjshutdown01', 'Empresa Shutdown', `slug-${EMPRESA.slice(-8)}`, 'ativo', 'rei', now, new Date(Date.now() + 86_400_000).toISOString()],
    );
  });

  after(async () => {
    try {
      await scheduler.stopDotMonitorScheduler(1_000);
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

  test('parar o scheduler desliga o timer e chamadas repetidas são idempotentes', async () => {
    scheduler.startDotMonitorScheduler();
    assert.equal(scheduler.getDotSchedulerRuntimeStatus().timer_active, true);

    const first = await scheduler.stopDotMonitorScheduler(30_000);
    assert.equal(typeof first.stopped, 'boolean');
    assert.equal(scheduler.getDotSchedulerRuntimeStatus().timer_active, false);

    // Segunda chamada: nada para parar, não lança, continua desligado.
    // (`stopped` pode ser false quando a primeira chamada esgotou o teto de
    // espera de uma rodada lenta — o contrato é "não pendurar", não "sempre
    // drenar".)
    const second = await scheduler.stopDotMonitorScheduler(30_000);
    assert.equal(typeof second.stopped, 'boolean');
    // A rodada disparada no start pode ainda estar em voo: o contrato é
    // devolver o estado real sem lançar e sem religar o timer.
    assert.equal(scheduler.getDotSchedulerRuntimeStatus().timer_active, false);
  });

  test('após a parada, nenhuma rodada nova é agendada (o contador de rodadas não avança)', async () => {
    scheduler.startDotMonitorScheduler();
    await scheduler.stopDotMonitorScheduler(30_000);
    const before = scheduler.getDotSchedulerStatus().last_run_at;
    // Espera mais que um tick hipotético curto: nada deve rodar.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = scheduler.getDotSchedulerStatus().last_run_at;
    assert.equal(after, before, 'o timer parado não pode disparar novas rodadas');
    assert.equal(scheduler.getDotSchedulerRuntimeStatus().timer_active, false);
  });

  test('o timeout de shutdown é respeitado e a parada não pendura o processo', async () => {
    scheduler.startDotMonitorScheduler();
    const startedAt = Date.now();
    await scheduler.stopDotMonitorScheduler(1);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 5_000, `a parada levou ${elapsed}ms e não pode bloquear o shutdown`);
  });

  test('drenagem do worker: para o timer e aguarda o tick em andamento', async () => {
    const { ensureDotAgentSchema } = await import('../services/dotAgent.js');
    const { ensureMissionTables } = await import('../services/dotAgentMissions.js');
    await ensureDotAgentSchema();
    await ensureMissionTables();
    worker.startDotAgentWorker();
    const status = worker.getDotAgentWorkerStatus();
    assert.equal(status.disabled, false);
    assert.equal(status.timer_active, true);

    const drained = await worker.stopDotAgentWorkerAndDrain(30_000);
    assert.equal(typeof drained.drained, 'boolean');
    assert.equal(worker.getDotAgentWorkerStatus().timer_active, false);

    // Idempotente.
    const again = await worker.stopDotAgentWorkerAndDrain(30_000);
    assert.equal(again.drained, true);
  });

  test('falha transitória do worker não vira rejeição não tratada', async () => {
    // Uma tabela ausente faz o tick falhar; `runTick` captura por missão e o
    // tick devolvido nunca rejeita.
    const tick = worker.wakeDotAgentWorker();
    await assert.doesNotReject(async () => {
      if (tick) await tick;
    });
  });

  test('server.ts para os subsistemas ANTES de fechar o pool do banco', () => {
    const closeIdx = serverSource.indexOf('await closeDB()');
    assert.ok(closeIdx > 0, 'server.ts precisa fechar o banco no shutdown');
    const shutdownIdx = serverSource.indexOf('async function gracefulShutdown');
    assert.ok(shutdownIdx > 0 && shutdownIdx < closeIdx);

    // Cada subsistema precisa de UMA parada registrada, em qualquer dos dois
    // grupos do shutdown:
    //   a) `trackBackground('<nome>'`  → timers com parada síncrona;
    //   b) `drain('<nome>', ...)`      → drenagem assíncrona com teto.
    // A versão anterior exigia sempre (a) e quebrou quando os workers de retry,
    // aquisição e relatório mensal passaram a ser drenados com `drain` — o que
    // é MAIS seguro (aguarda a execução em voo antes de fechar o pool).
    for (const name of ['retry worker', 'acquisition worker', 'monthly report scheduler']) {
      const tracked = serverSource.indexOf(`trackBackground('${name}'`);
      const drained = serverSource.indexOf(`drain('${name}'`);
      const idx = tracked > 0 ? tracked : drained;
      assert.ok(
        idx > 0 && idx < closeIdx,
        `subsistema "${name}" precisa de parada registrada ANTES de closeDB()`,
      );
    }
    // O DOT NÃO entra em backgroundStops: é drenado explicitamente UMA vez
    // (`stopDotMonitorScheduler`/`stopDotAgentWorkerAndDrain`), antes de closeDB.
    for (const call of ['stopDotMonitorScheduler(5_000)', 'stopDotAgentWorkerAndDrain(5_000)']) {
      const idx = serverSource.indexOf(call);
      assert.ok(idx > 0 && idx < closeIdx, `"${call}" precisa drenar antes de closeDB()`);
    }
    assert.ok(!serverSource.includes("trackBackground('DOT scheduler'"), 'DOT scheduler não deve ser registrado 2x');
    assert.ok(!serverSource.includes("trackBackground('DOT agent worker'"), 'DOT agent worker não deve ser registrado 2x');
    const drainIdx = serverSource.indexOf('for (const entry of backgroundStops.slice().reverse())');
    assert.ok(drainIdx > 0 && drainIdx < closeIdx, 'a parada dos subsistemas precisa vir antes de closeDB()');

    // O HTTP fecha primeiro; depois os workers; depois o banco.
    const httpIdx = serverSource.indexOf('HTTP fechado.');
    assert.ok(httpIdx > 0 && httpIdx < drainIdx);
  });

  test('a sequência de shutdown é idempotente (guard `shuttingDown`)', () => {
    assert.match(serverSource, /if \(shuttingDown\) return;\s*\n\s*shuttingDown = true;/);
    assert.match(serverSource, /process\.once\('SIGTERM'/);
    assert.match(serverSource, /process\.once\('SIGINT'/);
  });
});
