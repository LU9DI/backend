/**
 * Encerramento gracioso e execução real do Filtra Dot (ponta a ponta, SQLite).
 *
 * Prova o ciclo que a auditoria pedia:
 *   1. empresa elegível é identificada;
 *   2. o scheduler seleciona a empresa;
 *   3. o agente inicia uma execução (monitor cria evento → decisão → ação preparada);
 *   4. a execução é registrada (auditoria + fila);
 *   5. o consumo estimado é reservado no ledger;
 *   6. o consumo real é registrado quando disponível;
 *   7. a reserva é finalizada;
 *   8. retry não duplica consumo;
 *   9. falha ambígua não libera a reserva;
 *  10. alertas são emitidos e sanitizados.
 *
 * Não há chamada de rede: nenhum provedor é usado e nenhuma ação externa é
 * executada. As etapas 5–10 rodam contra o ledger com dados do próprio teste.
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

const tmpDb = path.join(os.tmpdir(), `filtra-dot-e2e-${Date.now()}-${process.pid}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.FILTRA_DOT_ENABLED = '1';
process.env.FILTRA_DOT_FORCE_ON = '1';
process.env.DOT_AGENT_WORKER_ENABLED = '0';
// Intervalo de checagem curto para a empresa ficar devida no teste.
process.env.FILTRA_DOT_MONITOR_TICK_MS = '60000';

const suite = sqliteAvailable ? describe : describe.skip;

const EMPRESA_ELEGIVEL = `e2e-rei-${crypto.randomUUID()}`;
const EMPRESA_INELEGIVEL = `e2e-pro-${crypto.randomUUID()}`;

let db: any;
let ledger: typeof import('../services/dotLedger.js');
let scheduler: typeof import('../services/dotScheduler.js');

async function seedEmpresa(id: string, plan: string, status = 'ativo') {
  const now = new Date().toISOString();
  const expira = new Date(Date.now() + 30 * 86_400_000).toISOString();
  await db.run(
    'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
    [id, `cnpj${id.replace(/\D/g, '').slice(0, 10)}`, 'Empresa E2E', `slug-${id.slice(-8)}`, status, plan, now, expira],
  );
}

async function seedReviews(empresaId: string, count: number, rating: number) {
  for (let i = 0; i < count; i += 1) {
    await db.run(
      'INSERT INTO reviews (empresa_id, name, rating, comment, ai_tags, createdAt) VALUES (?,?,?,?,?,?)',
      [empresaId, `Cliente ${i}`, rating, 'demorou muito', JSON.stringify(['espera']), new Date().toISOString()],
    );
  }
}

suite('Filtra Dot — execução real, ledger e encerramento gracioso', () => {
  before(async () => {
    const { initDB, getDb } = await import('../lib/db.js');
    await initDB();
    db = getDb();
    ledger = await import('../services/dotLedger.js');
    scheduler = await import('../services/dotScheduler.js');
    await ledger.ensureDotLedgerSchema();
    const { ensureDotAgentSchema } = await import('../services/dotAgent.js');
    const { ensureMissionTables } = await import('../services/dotAgentMissions.js');
    await ensureDotAgentSchema();
    await ensureMissionTables();

    await seedEmpresa(EMPRESA_ELEGIVEL, 'rei');
    await seedEmpresa(EMPRESA_INELEGIVEL, 'pro');
    await seedReviews(EMPRESA_ELEGIVEL, 8, 2);
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

  test('o scheduler identifica a empresa elegível e ignora a inelegível', async () => {
    const result = await scheduler.runDueDotMonitors();
    assert.equal(result.ok, true);
    const processadas = (result.results || []).map((item: any) => item.empresa_id);
    assert.ok(processadas.includes(EMPRESA_ELEGIVEL), 'empresa Rei ativa deve ser selecionada');
    assert.ok(!processadas.includes(EMPRESA_INELEGIVEL), 'empresa Pro não tem direito ao Dot');
  });

  test('o agente registra a execução: evento, decisão e ação preparada', async () => {
    const events = await db.all('SELECT id, type, severity FROM dot_events WHERE empresa_id = ?', [EMPRESA_ELEGIVEL]);
    assert.ok(events.length > 0, 'o monitor precisa registrar evento de reputação');
    const decisions = await db.all('SELECT id, status, requires_approval FROM dot_decisions WHERE empresa_id = ?', [EMPRESA_ELEGIVEL]);
    assert.ok(decisions.length > 0, 'o evento precisa virar decisão');
    const actions = await db.all('SELECT id, status FROM dot_action_queue WHERE empresa_id = ?', [EMPRESA_ELEGIVEL]);
    if (actions.length) {
      assert.ok(['prepared', 'approved'].includes(String(actions[0].status)));
      const audit = await db.all('SELECT event FROM dot_action_audit WHERE empresa_id = ?', [EMPRESA_ELEGIVEL]);
      assert.ok(audit.length > 0, 'toda ação preparada precisa de trilha de auditoria');
    }
    // Nada externo foi executado: o gateway continua exigindo aprovação.
    const executed = await db.all("SELECT id FROM dot_action_queue WHERE empresa_id = ? AND status = 'executed'", [EMPRESA_ELEGIVEL]);
    assert.equal(executed.length, 0, 'nenhuma ação pode ser executada sem aprovação explícita');
  });

  test('o ciclo do orçamento registra reserva, consumo real e finalização', async () => {
    const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA_ELEGIVEL, plan: 'rei', executionRef: 'e2e-chat' });
    assert.equal(reserved.ok, true);
    const id = reserved.reservation!.id;

    const finalized = await ledger.finalizeDotReservation({
      empresaId: EMPRESA_ELEGIVEL,
      reservationId: id,
      tokens: 950,
      estimatedTokens: reserved.snapshot.response_limit,
      provider: 'groq',
      tipo: 'filtra_dot_chat',
    });
    assert.equal(finalized.ok, true);
    assert.equal(finalized.reservation?.status, 'settled');

    const usage = await db.get(
      'SELECT COUNT(*) AS c, COALESCE(SUM(tokens),0) AS t FROM ai_usage WHERE empresa_id = ? AND feature = ?',
      [EMPRESA_ELEGIVEL, 'dot'],
    );
    assert.equal(Number(usage.c), 1);
    assert.ok(Number(usage.t) >= 950, 'o consumo registrado cobre o uso real');

    // Retry da mesma execução: não duplica consumo.
    const retry = await ledger.finalizeDotReservation({
      empresaId: EMPRESA_ELEGIVEL,
      reservationId: id,
      tokens: 950,
      provider: 'groq',
    });
    assert.equal(retry.duplicate, true);
    const after = await db.get(
      'SELECT COUNT(*) AS c FROM ai_usage WHERE empresa_id = ? AND feature = ?',
      [EMPRESA_ELEGIVEL, 'dot'],
    );
    assert.equal(Number(after.c), 1);
  });

  test('falha ambígua mantém a reserva aberta e o orçamento comprometido', async () => {
    const before = await ledger.getDotBudgetSnapshot(EMPRESA_ELEGIVEL, 'rei');
    const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA_ELEGIVEL, plan: 'rei', executionRef: 'e2e-ambiguous' });
    const ambiguous = await ledger.finalizeDotReservation({
      empresaId: EMPRESA_ELEGIVEL,
      reservationId: reserved.reservation!.id,
      ambiguous: true,
      estimatedTokens: reserved.snapshot.response_limit,
      ambiguousReason: 'timeout do provedor após envio',
    });
    assert.equal(ambiguous.reservation?.status, 'pending');
    const after = await ledger.getDotBudgetSnapshot(EMPRESA_ELEGIVEL, 'rei');
    assert.ok(after.reserved >= before.reserved + reserved.snapshot.response_limit - 1);
    assert.ok(after.ambiguous > 0);
    const alert = ledger.buildDotBudgetAlert(after);
    assert.equal(alert?.event, 'dot_budget_ambiguous');
  });

  test('o alerta emitido não carrega dado sensível', () => {
    const alert = ledger.buildDotBudgetAlert({
      empresa_id: 'empresa-secreta',
      plan: 'rei',
      feature: 'dot',
      limit: 1000,
      feedback_limit: 0,
      used: 1000,
      reserved: 0,
      ambiguous: 0,
      remaining: 0,
      response_limit: 900,
      warning: false,
      exhausted: true,
      percent: 1,
      pending_reservations: 0,
    });
    assert.ok(alert);
    const serialized = JSON.stringify(alert);
    assert.ok(!serialized.includes('empresa-secreta'), 'alerta não pode expor o identificador da empresa');
    assert.ok(!/@/.test(serialized));
    assert.ok(!/\d{10,}/.test(serialized));
  });

  test('o encerramento gracioso para o scheduler e drena o worker sem pendurar o processo', async () => {
    scheduler.startDotMonitorScheduler();
    const status = scheduler.getDotSchedulerRuntimeStatus();
    assert.equal(status.timer_active, true);

    const worker = await import('../services/dotAgentWorker.js');
    // `startDotMonitorScheduler` dispara uma rodada imediata; a parada
    // graciosa precisa aguardá-la (ou desistir dentro do teto), nunca pendurar.
    const startedAt = Date.now();
    const stopped = await scheduler.stopDotMonitorScheduler(2_000);
    assert.ok(Date.now() - startedAt < 5_000, 'a parada não pode pendurar o processo');
    assert.equal(typeof stopped.stopped, 'boolean');
    assert.equal(scheduler.getDotSchedulerRuntimeStatus().timer_active, false);

    const drained = await worker.stopDotAgentWorkerAndDrain(2_000);
    assert.equal(drained.drained, true);
    assert.equal(worker.getDotAgentWorkerStatus().timer_active, false);
  });
});
