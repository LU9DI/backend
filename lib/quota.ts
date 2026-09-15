/** Limites de feedbacks/mês e cotas de IA (tokens). Postgres-safe. */
import { getDb, dbEngine } from './db.js';
import { getCurrentMonth } from './planUtils.js';

export const PLAN_FEEDBACK_LIMITS: Record<string, number> = {
  trial: 30,
  teste: 30,
  inicial: 100,
  pro: 300,
  ultra: 800,
  corporativo: 2500,
  rei: 8000,
};
export const PLAN_TOKEN_LIMITS: Record<string, number> = {
  trial: 25_000,
  teste: 25_000,
  inicial: 0,
  pro: 0,
  ultra: 120_000,
  corporativo: 400_000,
  rei: 1_200_000,
};

const AI_REVIEW_RESERVATION = Math.max(
  400,
  Number(process.env.AI_REVIEW_RESERVATION_TOKENS || 900)
);
const AI_RESERVATION_TTL_MS = Math.max(
  5_000,
  Number(process.env.AI_REVIEW_RESERVATION_TTL_MS || 30_000)
);
const aiReservations = new Map<string, { tokens: number; expiresAt: number }>();
function cleanupAiReservations(now = Date.now()) {
  for (const [empresaId, r] of aiReservations) {
    if (r.expiresAt <= now) aiReservations.delete(empresaId);
  }
}

export function planTemIA(plan: string | null | undefined): boolean {
  const p = String(plan || '').toLowerCase();
  if (p === 'inicial' || p === 'pro') return false;
  return ['ultra', 'corporativo', 'rei', 'trial', 'teste'].includes(p);
}
export function getFeedbackLimit(plan: string): number {
  return PLAN_FEEDBACK_LIMITS[String(plan || 'trial').toLowerCase()] ?? PLAN_FEEDBACK_LIMITS.trial;
}
export function getTokenLimit(plan: string): number {
  return PLAN_TOKEN_LIMITS[String(plan || 'trial').toLowerCase()] ?? PLAN_TOKEN_LIMITS.trial;
}
function monthStartIso(mes?: string): string {
  const m = mes || getCurrentMonth();
  return `${m}-01T00:00:00.000Z`;
}
function nextMonthStartIso(mes?: string): string {
  const m = mes || getCurrentMonth();
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString();
}

export async function tokensUsadosMes(empresaId: string): Promise<number> {
  const db = getDb();
  const mes = getCurrentMonth();
  try {
    if (dbEngine() === 'postgres') {
      const row = await db.get(
        `SELECT COALESCE(SUM(tokens),0) as t FROM ai_usage
         WHERE empresa_id = ? AND criado_em >= ? AND criado_em < ?`,
        [empresaId, monthStartIso(mes), nextMonthStartIso(mes)]
      );
      return Number(row?.t || 0);
    }
    const row = await db.get(
      `SELECT COALESCE(SUM(tokens),0) as t FROM ai_usage
       WHERE empresa_id = ? AND substr(criado_em, 1, 7) = ?`,
      [empresaId, mes]
    );
    return Number(row?.t || 0);
  } catch {
    return 0;
  }
}

export async function assertEmpresaTokenQuota(
  empresaId: string | null | undefined,
  plan: string | null | undefined
): Promise<{ ok: boolean; used: number; reserved: number; limit: number }> {
  if (!empresaId) return { ok: true, used: 0, reserved: 0, limit: 0 };
  const limit = getTokenLimit(String(plan || 'trial'));
  if (limit <= 0) return { ok: false, used: 0, reserved: 0, limit: 0 };
  cleanupAiReservations();
  const used = await tokensUsadosMes(empresaId);
  const existing = aiReservations.get(empresaId)?.tokens || 0;
  if (limit - used - existing < AI_REVIEW_RESERVATION) {
    return { ok: false, used, reserved: existing, limit };
  }
  aiReservations.set(empresaId, {
    tokens: existing + AI_REVIEW_RESERVATION,
    expiresAt: Date.now() + AI_RESERVATION_TTL_MS,
  });
  return { ok: true, used, reserved: existing + AI_REVIEW_RESERVATION, limit };
}

export async function checkQuota(plan: string, type: 'tags' | 'respostas'): Promise<void> {
  const db = getDb();
  const month = getCurrentMonth();
  const row = await db.get(`SELECT ${type} FROM usage WHERE plan = ? AND month = ?`, [
    plan,
    month,
  ]);
  const limit =
    plan === 'rei' || plan === 'corporativo' ? 20000 : plan === 'ultra' ? 4000 : 1500;
  if (row && row[type] >= limit) {
    throw new Error(`Limite mensal de ${type} para o plano ${plan} atingido`);
  }
  await db.run(
    `INSERT INTO usage (plan, month, ${type}) VALUES (?, ?, 1)
     ON CONFLICT(plan, month) DO UPDATE SET ${type} = ${type} + 1`,
    [plan, month]
  );
}

/** Conta reviews do mês corrente — sem substr() em timestamp (Postgres). */
export async function contarReviewsMes(empresaId: string): Promise<number> {
  const db = getDb();
  const mes = getCurrentMonth();
  const start = monthStartIso(mes);
  const end = nextMonthStartIso(mes);
  const isPg = dbEngine() === 'postgres';

  const queries = isPg
    ? [
        // coluna citável mixed-case
        `SELECT COUNT(*)::int as c FROM reviews
         WHERE empresa_id = $1 AND COALESCE(is_test, 0) = 0
           AND "createdAt" >= $2 AND "createdAt" < $3`,
        `SELECT COUNT(*)::int as c FROM reviews
         WHERE empresa_id = $1 AND COALESCE(is_test, 0) = 0
           AND created_at >= $2 AND created_at < $3`,
        `SELECT COUNT(*)::int as c FROM reviews
         WHERE empresa_id = $1 AND COALESCE(is_test, 0) = 0
           AND createdat >= $2 AND createdat < $3`,
        // fallback textual
        `SELECT COUNT(*)::int as c FROM reviews
         WHERE empresa_id = $1 AND COALESCE(is_test, 0) = 0
           AND to_char(COALESCE("createdAt", created_at, createdat)::timestamptz, 'YYYY-MM') = $2`,
      ]
    : [
        `SELECT COUNT(*) as c FROM reviews
         WHERE empresa_id = ? AND COALESCE(is_test, 0) = 0
           AND createdAt >= ? AND createdAt < ?`,
        `SELECT COUNT(*) as c FROM reviews
         WHERE empresa_id = ? AND COALESCE(is_test, 0) = 0
           AND created_at >= ? AND created_at < ?`,
      ];

  for (const q of queries) {
    try {
      // getDb adapter ainda espera ? — usa sempre ?
      const sql = q.replace(/\$1/g, '?').replace(/\$2/g, '?').replace(/\$3/g, '?');
      const params = sql.includes('to_char')
        ? [empresaId, mes]
        : [empresaId, start, end];
      // evita triple-param quando só 2 placeholders
      const ph = (sql.match(/\?/g) || []).length;
      const row = await db.get(sql, params.slice(0, ph));
      return Number(row?.c || 0);
    } catch {
      /* tenta próxima */
    }
  }
  return 0;
}
