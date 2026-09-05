/** Limites de feedbacks/mês e cotas de IA. */
import { getDb } from './db.js';
import { getCurrentMonth } from './planUtils.js';

export const PLAN_FEEDBACK_LIMITS: Record<string, number> = {
  trial: 30,
  teste: 30,
  inicial: 150,
  pro: 400,
  ultra: 800,
  corporativo: 2500,
  rei: 8000,
};

/**
 * Respostas/tags de IA: trial (demo), Ultra, Corporativo e Rei.
 * Inicial e Pro NÃO têm IA (só volume + WPP + gráficos).
 */
export function planTemIA(plan: string | null | undefined): boolean {
  const p = String(plan || '').toLowerCase();
  if (p === 'inicial' || p === 'pro') return false;
  return ['ultra', 'corporativo', 'rei', 'trial', 'teste'].includes(p);
}

export function getFeedbackLimit(plan: string): number {
  const key = String(plan || 'trial').toLowerCase();
  return PLAN_FEEDBACK_LIMITS[key] ?? PLAN_FEEDBACK_LIMITS.trial;
}

export async function checkQuota(plan: string, type: 'tags' | 'respostas'): Promise<void> {
  const db = getDb();
  const month = getCurrentMonth();
  const row = await db.get(`SELECT ${type} FROM usage WHERE plan = ? AND month = ?`, [plan, month]);
  const limit =
    plan === 'rei' || plan === 'corporativo'
      ? 20000
      : plan === 'ultra'
        ? 4000
        : 1500;
  if (row && row[type] >= limit) {
    throw new Error(`Limite mensal de ${type} para o plano ${plan} atingido`);
  }
  await db.run(
    `INSERT INTO usage (plan, month, ${type}) VALUES (?, ?, 1)
    ON CONFLICT(plan, month) DO UPDATE SET ${type} = ${type} + 1`,
    [plan, month]
  );
}

export async function contarReviewsMes(empresaId: string): Promise<number> {
  const db = getDb();
  const mes = getCurrentMonth();
  const row = await db.get(
    `SELECT COUNT(*) as c FROM reviews
     WHERE empresa_id = ? AND substr(createdAt, 1, 7) = ?`,
    [empresaId, mes]
  );
  return Number(row?.c || 0);
}
