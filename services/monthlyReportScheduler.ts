/**
 * Agendador in-process do relatório profissional mensal.
 *
 * Gera e persiste o snapshot do mês anterior sem cron externo e sem
 * credenciais: o próprio processo da API dispara o job uma vez por período.
 * Ligado por padrão; MONTHLY_REPORT_SCHEDULER=0/false/off desliga.
 * A distribuição externa continua governada por MONTHLY_REPORT_EXTERNAL_DELIVERY
 * (desligada por padrão — ver routes/monthlyReportJobsRoutes.ts).
 */
import { getDb } from '../lib/db.js';
import { runMonthlyReportJob, type MonthlyReportStats } from '../routes/monthlyReportJobsRoutes.js';

const DEFAULT_TICK_MS = 6 * 60 * 60 * 1000;
const MIN_TICK_MS = 60 * 1000;
const FIRST_TICK_DELAY_MS = 15 * 1000;

export function monthlyReportSchedulerEnabled(): boolean {
  const v = String(process.env.MONTHLY_REPORT_SCHEDULER || '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off') return false;
  return true;
}

export function monthlyReportTickMs(): number {
  const raw = Number(process.env.MONTHLY_REPORT_SCHEDULER_TICK_MS);
  return Number.isFinite(raw) && raw >= MIN_TICK_MS ? Math.floor(raw) : DEFAULT_TICK_MS;
}

/** Período alvo do agendador: o mês UTC anterior (mesmo critério da rota manual). */
export function monthlyReportPeriodFor(now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

type SchedulerDeps = {
  db?: any;
  run?: (db: any, periodo: string) => Promise<MonthlyReportStats>;
  now?: Date;
};

export type MonthlyReportTickResult =
  | { ran: false; reason: 'disabled' | 'in_progress' | 'already_ran' | 'error'; periodo?: string; error?: string }
  | { ran: true; reason: 'ok'; periodo: string; stats: MonthlyReportStats };

let timer: ReturnType<typeof setInterval> | null = null;
let firstTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let ticking = false;
let lastPeriod: string | null = null;
let lastRunDay: string | null = null;
let lastRunAt: string | null = null;
let lastError: string | null = null;

export function getMonthlyReportSchedulerStatus() {
  return {
    enabled: monthlyReportSchedulerEnabled(),
    started,
    ticking,
    tick_ms: monthlyReportTickMs(),
    last_period: lastPeriod,
    last_run_day: lastRunDay,
    ran_today: lastRunDay === new Date().toISOString().slice(0, 10),
    last_run_at: lastRunAt,
    last_error: lastError,
  };
}

/**
 * Um tick do agendador: roda o job mensal para o período alvo no máximo uma vez
 * por dia UTC. Erros não marcam o dia como concluído (o próximo tick tenta de
 * novo); sucesso marca, e o job volta a rodar no dia seguinte (ou na virada do
 * mês, quando o período-alvo muda).
 */
export async function runMonthlyReportSchedulerTick(deps: SchedulerDeps = {}): Promise<MonthlyReportTickResult> {
  if (!monthlyReportSchedulerEnabled()) return { ran: false, reason: 'disabled' };
  if (ticking) return { ran: false, reason: 'in_progress' };
  const now = deps.now || new Date();
  const periodo = monthlyReportPeriodFor(now);
  const today = now.toISOString().slice(0, 10);
  if (lastRunDay === today) return { ran: false, reason: 'already_ran', periodo };
  ticking = true;
  try {
    const db = deps.db || getDb();
    const run = deps.run || runMonthlyReportJob;
    const stats = await run(db, periodo);
    lastPeriod = periodo;
    lastRunDay = now.toISOString().slice(0, 10);
    lastRunAt = new Date().toISOString();
    lastError = null;
    console.log(
      `[monthly-report] agendador: período ${periodo} processado (candidatos=${stats.candidatos}, pulados=${stats.pulados}, snapshots=${stats.snapshots_gerados + stats.snapshots_recuperados}, falhas=${stats.falhas})`
    );
    return { ran: true, reason: 'ok', periodo, stats };
  } catch (error: any) {
    lastError = String(error?.message || error).slice(0, 500);
    console.warn('[monthly-report] agendador falhou:', lastError);
    return { ran: false, reason: 'error', periodo, error: lastError };
  } finally {
    ticking = false;
  }
}

export function startMonthlyReportScheduler() {
  if (started || timer) return;
  if (String(process.env.NODE_ENV || '') === 'test') {
    console.log('[monthly-report] agendador não inicia em ambiente de teste.');
    return;
  }
  if (!monthlyReportSchedulerEnabled()) {
    console.log('[monthly-report] agendador desligado (MONTHLY_REPORT_SCHEDULER=0); o job segue acessível em POST /api/jobs/monthly-reports.');
    return;
  }
  started = true;
  const tickMs = monthlyReportTickMs();
  console.log(
    `[monthly-report] agendador ativo: período alvo ${monthlyReportPeriodFor()} (tick ${tickMs}ms, sem credenciais externas).`
  );
  firstTimer = setTimeout(() => { void runMonthlyReportSchedulerTick(); }, FIRST_TICK_DELAY_MS);
  firstTimer.unref?.();
  timer = setInterval(() => { void runMonthlyReportSchedulerTick(); }, tickMs);
  timer.unref?.();
}

export function stopMonthlyReportScheduler() {
  if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
  started = false;
}
