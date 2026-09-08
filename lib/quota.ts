/** Limites de feedbacks/mês e cotas de IA (tokens). */
import { getDb } from './db.js';
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

/**
 * Teto mensal de tokens de IA por empresa.
 * Inicial/Pro = 0 (sem IA). Trial baixo. Ultra+ sobe gradualmente.
 */
export const PLAN_TOKEN_LIMITS: Record<string, number> = {
  trial: 25_000,
  teste: 25_000,
  inicial: 0,
  pro: 0,
  ultra: 120_000,
  corporativo: 400_000,
  rei: 1_200_000,
};

/** Inicial e Pro NÃO têm IA. */
export function planTemIA(plan: string | null | undefined): boolean {
  const p = String(plan || '').toLowerCase();
  if (p === 'inicial' || p === 'pro') return false;
  return ['ultra', 'corporativo', 'rei', 'trial', 'teste'].includes(p);
}

export function getFeedbackLimit(plan: string): number {
  const key = String(plan || 'trial').toLowerCase();
  return PLAN_FEEDBACK_LIMITS[key] ?? PLAN_FEEDBACK_LIMITS.trial;
}

export function getTokenLimit(plan: string): number {
  const key = String(plan || 'trial').toLowerCase();
  return PLAN_TOKEN_LIMITS[key] ?? PLAN_TOKEN_LIMITS.trial;
}

export async function tokensUsadosMes(empresaId: string): Promise<number> {
  const db = getDb();
  const mes = getCurrentMonth();
  const row = await db.get(
    `SELECT COALESCE(SUM(tokens),0) as t FROM ai_usage
     WHERE empresa_id = ? AND substr(criado_em::text, 1, 7) = ?`,
    [empresaId, mes]
  ).catch(async () =>
    db.get(
      `SELECT COALESCE(SUM(tokens),0) as t FROM ai_usage
       WHERE empresa_id = ? AND substr(criado_em, 1, 7) = ?`,
      [empresaId, mes]
    )
  );
  return Number((row as any)?.t || 0);
}

export async function assertEmpresaTokenQuota(
  empresaId: string | null | undefined,
  plan: string | null | undefined
): Promise<{ ok: boolean; used: number; limit: number }> {
  if (!empresaId) return { ok: true, used: 0, limit: 0 };
  const limit = getTokenLimit(String(plan || 'trial'));
  if (limit <= 0) return { ok: false, used: 0, limit: 0 };
  const used = await tokensUsadosMes(empresaId);
  return { ok: used < limit, used, limit };
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
  try {
    const row = await db.get(
      `SELECT COUNT(*) as c FROM reviews
       WHERE empresa_id = ? AND substr(createdAt::text, 1, 7) = ?`,
      [empresaId, mes]
    );
    return Number(row?.c || 0);
  } catch {
    const row = await db.get(
      `SELECT COUNT(*) as c FROM reviews
       WHERE empresa_id = ? AND substr(createdAt, 1, 7) = ?`,
      [empresaId, mes]
    );
    return Number(row?.c || 0);
  }
}
