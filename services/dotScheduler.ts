import { getDb } from '../lib/db.js';
import { getDotPreferences } from './dotPreferences.js';
import { runDotMonitor } from './dotMonitor.js';
import { monitorDueDotFollowUps } from './dotFollowUp.js';
import { withDotLock } from './dotCoordination.js';

type DotSchedulerStatus = {
  running: boolean;
  started_at: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  duration_ms: number | null;
  companies_processed: number;
  companies_skipped: number;
  companies_errors: number;
  followups_processed: number;
  events_created: number;
  decisions_created: number;
  actions_prepared: number;
};

const schedulerStatus: DotSchedulerStatus = {
  running: false,
  started_at: null,
  last_run_at: null,
  last_success_at: null,
  last_error_at: null,
  last_error: null,
  duration_ms: null,
  companies_processed: 0,
  companies_skipped: 0,
  companies_errors: 0,
  followups_processed: 0,
  events_created: 0,
  decisions_created: 0,
  actions_prepared: 0,
};

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * A rodada em andamento, quando existe.
 *
 * O agendador só usa `setInterval` (unref'd), mas uma rodada em curso mantém
 * trabalho assíncrono vivo: sem referência, o encerramento gracioso do
 * processo (SIGTERM do Render) poderia interromper uma rodada no meio de uma
 * transação. `stopDotMonitorScheduler` permite aguardar a rodada terminar
 * dentro do orçamento de shutdown.
 */
let currentRun: Promise<unknown> | null = null;
/** Marcado pela parada: nenhuma rodada NOVA pode iniciar. */
let stopped = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ensureSchedulerColumn() {
  const db = getDb();
  const cols = (await db.all('PRAGMA table_info(empresas)')).map((c: { name?: string }) => String(c.name || ''));
  if (!cols.includes('dot_monitor_last_at')) await db.exec('ALTER TABLE empresas ADD COLUMN dot_monitor_last_at TEXT');
}

export function getDotSchedulerStatus() {
  return {
    ...schedulerStatus,
    timer_active: Boolean(timer),
    tick_ms: Math.max(60_000, Number(process.env.FILTRA_DOT_MONITOR_TICK_MS || 300_000)),
  };
}

export async function runDueDotMonitors() {
  // Rodada já em andamento NESTA instância (memória). Devolve o mesmo shape da
  // rodada concluída para os consumidores acessarem os campos sem checagens.
  if (running) return { ok: true, skipped: true, reason: 'already_running', processed: 0, results: [], followups: [] };
  // Coordenação durável: a rodada do agendador (follow-ups + monitor de todas
  // as empresas) roda em uma única instância por vez. A instância que não
  // obtiver o lock devolve `skipped` e o próximo tick tenta de novo — os
  // monitors por empresa têm lock próprio como segunda linha de defesa.
  const lock = await withDotLock('dot:scheduler', 10 * 60_000, () => runDueDotMonitorsUnlocked(), { waitMs: 0 });
  if (!lock.acquired) {
    return { ok: true, skipped: true, reason: 'outra instância está executando a rodada do agendador', processed: 0, results: [], followups: [] };
  }
  return lock.result;
}

async function runDueDotMonitorsUnlocked() {
  if (running) return { ok: true, skipped: true, reason: 'already_running', processed: 0, results: [], followups: [] };

  running = true;
  const startedAt = new Date();
  schedulerStatus.running = true;
  schedulerStatus.started_at = startedAt.toISOString();
  schedulerStatus.last_run_at = startedAt.toISOString();
  const startedMs = Date.now();

  try {
    await ensureSchedulerColumn();
    const db = getDb();
    const companies = await db.all(
      `SELECT id, plan, status, dot_monitor_last_at FROM empresas
       WHERE status IN ('ativo', 'trial')
         AND LOWER(IFNULL(plan, '')) IN ('rei', 'rei-anual', 'corporativo', 'corporativo-anual', 'corp', 'corp-anual', 'corporate', 'corporate-anual')`
    );
    const schedulerCandidates = await db.all(
      `SELECT status, LOWER(IFNULL(plan, '')) AS plan, COUNT(*) AS total
       FROM empresas
       WHERE status IN ('ativo', 'trial')
       GROUP BY status, LOWER(IFNULL(plan, ''))
       ORDER BY status, plan`
    );
    console.log('[dot-scheduler] candidatos observados', schedulerCandidates);
    let processed = 0;
    let skipped = 0;
    let due = 0;
    let companyErrors = 0;
    let eventsCreated = 0;
    let decisionsCreated = 0;
    let actionsPrepared = 0;
    const results = [];

    const followUpResults = await monitorDueDotFollowUps();
    const followupsProcessed = followUpResults.length;
    for (const followup of followUpResults) {
      eventsCreated += followup?.reassessment?.event_id ? 1 : 0;
      decisionsCreated += Array.isArray(followup?.decisions) ? followup.decisions.length : 0;
      actionsPrepared += Array.isArray(followup?.prepared_actions) ? followup.prepared_actions.length : 0;
    }

    for (const company of companies || []) {
      const p = await getDotPreferences(company.id);
      const last = company.dot_monitor_last_at ? new Date(company.dot_monitor_last_at).getTime() : 0;
      const intervalMs = p.checkIntervalMinutes * 60_000;
      const isDue = !last || Date.now() - last >= intervalMs;
      if (!isDue) { skipped++; continue; }
      due++;
      try {
        const result = await runDotMonitor(company.id);
        await db.run('UPDATE empresas SET dot_monitor_last_at = ? WHERE id = ?', [new Date().toISOString(), company.id]);
        processed++;
        eventsCreated += Array.isArray(result.events) ? result.events.length : 0;
        decisionsCreated += Array.isArray(result.decisions) ? result.decisions.length : 0;
        actionsPrepared += Array.isArray(result.prepared_actions) ? result.prepared_actions.length : 0;
        results.push({ empresa_id: company.id, ...result });
      } catch (error) {
        companyErrors++;
        const message = errorMessage(error).slice(0, 300);
        // Erros por empresa precisam ficar observáveis mesmo quando a rodada
        // segue para as demais; o log carrega apenas id da empresa e a
        // mensagem técnica — nunca conteúdo de avaliação ou credenciais.
        console.warn('[dot-scheduler] empresa falhou', { empresa_id: company.id, error: message });
        results.push({ empresa_id: company.id, ok: false, error: message });
      }
    }

    schedulerStatus.last_success_at = new Date().toISOString();
    schedulerStatus.last_error_at = companyErrors ? new Date().toISOString() : null;
    schedulerStatus.last_error = companyErrors ? `${companyErrors} empresa(s) falharam durante a rodada.` : null;
    schedulerStatus.duration_ms = Date.now() - startedMs;
    schedulerStatus.companies_processed = processed;
    schedulerStatus.companies_skipped = skipped;
    schedulerStatus.companies_errors = companyErrors;
    schedulerStatus.followups_processed = followupsProcessed;
    schedulerStatus.events_created = eventsCreated;
    schedulerStatus.decisions_created = decisionsCreated;
    schedulerStatus.actions_prepared = actionsPrepared;

    console.log('[dot-scheduler] rodada concluída', {
      eligible_companies: companies?.length || 0,
      due,
      processed,
      skipped,
      errors: companyErrors,
      followups: followupsProcessed,
      events: eventsCreated,
      decisions: decisionsCreated,
      actions_prepared: actionsPrepared,
      duration_ms: schedulerStatus.duration_ms,
    });

    return { ok: true, processed, skipped, results, followups: followUpResults };
  } catch (error) {
    schedulerStatus.last_error_at = new Date().toISOString();
    schedulerStatus.last_error = errorMessage(error).slice(0, 500);
    schedulerStatus.duration_ms = Date.now() - startedMs;
    console.warn('[dot-scheduler] rodada falhou', {
      error: schedulerStatus.last_error,
      duration_ms: schedulerStatus.duration_ms,
    });
    throw error;
  } finally {
    schedulerStatus.running = false;
    running = false;
  }
}

/**
 * Invariante de boot: o monitor só pode rodar com o Dot habilitado E a
 * validação explícita (`FILTRA_DOT_FORCE_ON=1`). Exportada para teste — o
 * servidor já chama o start apenas dentro do bloco do Dot.
 */
export function dotSchedulerRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FILTRA_DOT_ENABLED === '1' && env.FILTRA_DOT_FORCE_ON === '1';
}

export function startDotMonitorScheduler() {
  if (timer) return;
  // Forçado OFF até validação local do Dot. Para ligar de novo: FILTRA_DOT_ENABLED=1 e FILTRA_DOT_FORCE_ON=1.
  if (!dotSchedulerRuntimeEnabled()) {
    console.log('Filtra Dot monitor desativado — teste em localhost primeiro (precisa FILTRA_DOT_ENABLED=1 e FILTRA_DOT_FORCE_ON=1).');
    return;
  }
  const interval = Math.max(60_000, Number(process.env.FILTRA_DOT_MONITOR_TICK_MS || 300_000));
  stopped = false;
  const tick = () => {
    // Uma única rodada por vez; o tick REUTILIZA a rodada em andamento em vez
    // de enfileirar uma cópia imediata de `runDueDotMonitors()`.
    if (stopped || currentRun) return;
    // `currentRun` recebe a promessa COMPLETA, incluindo o bloco de limpeza —
    // assim a parada só retorna quando NENHUMA consulta da rodada pode mais
    // acontecer. Cada etapa interna é idempotente e transacional.
    // `let` (e nao `const`) evita o TS2454: a promessa e atribuida antes de o
    // `finally` assincrono executar; a comparacao por identidade impede que um
    // `stop`+`start` concorrente zere a referencia de outra rodada.
    let run: Promise<void> | null = null;
    run = (async () => {
      try {
        await runDueDotMonitors();
      } catch (error) {
        console.warn('Dot scheduler:', errorMessage(error));
      } finally {
        if (currentRun === run) currentRun = null;
      }
    })();
    currentRun = run;
  };
  tick();
  timer = setInterval(tick, interval);
  timer.unref();
  console.log(`Filtra Dot monitor ativo — tick ${Math.round(interval / 1000)}s`);
}

/** Estado para `/api/dot/status` (observabilidade do agendador). */
export function getDotSchedulerRuntimeStatus() {
  return { timer_active: Boolean(timer), running, in_flight: Boolean(currentRun), stopped };
}

/**
 * Para o agendador e aguarda (limitado) a rodada em andamento.
 *
 * Nunca espera indefinidamente — a rodada que não terminar dentro de
 * `timeoutMs` é interrompida pelo `process.exit` do shutdown, e nada é
 * corrompido porque cada etapa é idempotente e transacional.
 *
 * Não fecha conexões nem toca o pool do banco, e não executa sweep nem
 * reconciliação do ledger: reservas ambíguas do Dot permanecem intactas.
 */
export async function stopDotMonitorScheduler(timeoutMs = 5_000): Promise<{ stopped: boolean; in_flight: boolean }> {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const inFlight = currentRun;
  if (!inFlight) return { stopped: true, in_flight: false };
  let timedOut = false;
  const guard = new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      timedOut = true;
      resolve();
    }, Math.max(0, timeoutMs));
    if (typeof (t as any).unref === 'function') (t as any).unref();
  });
  await Promise.race([inFlight.catch(() => undefined), guard]);
  // Sucesso: o `finally` da rodada já zerou `currentRun` -> nada em voo.
  // Timeout: a rodada continua e NÃO pode ser reportada como drenada.
  return { stopped: !timedOut, in_flight: timedOut ? Boolean(currentRun) : false };
}
