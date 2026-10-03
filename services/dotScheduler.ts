import { getDb } from '../lib/db.js';
import { getDotPreferences } from './dotPreferences.js';
import { runDotMonitor } from './dotMonitor.js';
import { monitorDueDotFollowUps } from './dotFollowUp.js';

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

async function ensureSchedulerColumn() {
  const db = getDb();
  const cols = (await db.all('PRAGMA table_info(empresas)')).map((c: any) => c.name);
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
  if (running) return { ok: true, skipped: true, reason: 'already_running' };

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
         AND LOWER(IFNULL(plan, '')) IN ('rei', 'corporativo', 'corp')`
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
      const due = !last || Date.now() - last >= p.checkIntervalMinutes * 60_000;
      if (!due) { skipped++; continue; }
      due++;
      try {
        const result = await runDotMonitor(company.id);
        await db.run('UPDATE empresas SET dot_monitor_last_at = ? WHERE id = ?', [new Date().toISOString(), company.id]);
        processed++;
        eventsCreated += Array.isArray(result.events) ? result.events.length : 0;
        decisionsCreated += Array.isArray(result.decisions) ? result.decisions.length : 0;
        actionsPrepared += Array.isArray(result.prepared_actions) ? result.prepared_actions.length : 0;
        results.push({ empresa_id: company.id, ...result });
      } catch (error: any) {
        companyErrors++;
        results.push({ empresa_id: company.id, ok: false, error: String(error?.message || error) });
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
  } catch (error: any) {
    schedulerStatus.last_error_at = new Date().toISOString();
    schedulerStatus.last_error = String(error?.message || error).slice(0, 500);
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

export function startDotMonitorScheduler() {
  if (timer) return;
  if (process.env.NODE_ENV === 'production' && process.env.FILTRA_DOT_ENABLED !== '1') {
    console.log('🤖 Filtra Dot monitor desativado — defina FILTRA_DOT_ENABLED=1 para ativar em produção.');
    return;
  }
  const interval = Math.max(60_000, Number(process.env.FILTRA_DOT_MONITOR_TICK_MS || 300_000));
  void runDueDotMonitors().catch((error) => console.warn('Dot scheduler startup:', error?.message || error));
  timer = setInterval(() => {
    void runDueDotMonitors().catch((error) => console.warn('Dot scheduler:', error?.message || error));
  }, interval);
  timer.unref();
  console.log(`🤖 Filtra Dot monitor ativo — tick ${Math.round(interval / 1000)}s`);
}