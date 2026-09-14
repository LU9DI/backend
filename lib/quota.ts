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

export const PLAN_TOKEN_LIMITS: Record<string, number> = {
  trial: 25_000,
  teste: 25_000,
  inicial: 0,
  pro: 0,
  ultra: 120_000,
  corporativo: 400_000,
  rei: 1_200_000,
};

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

function monthPrefix(isoLike: unknown): string {
  return String(isoLike || '').slice(0, 7);
}

export async function tokensUsadosMes(empresaId: string): Promise<number> {
  const db = getDb();
  const mes = getCurrentMonth();
  try {
    // Sem substr/cast ambíguo — filtra em JS se necessário
    const rows = await db.all(
      `SELECT tokens, criado_em FROM ai_usage WHERE empresa_id = ? LIMIT 5000`,
      [empresaId]
    );
    let sum = 0;
    for (const r of rows || []) {
      if (monthPrefix((r as any).criado_em) === mes) {
        sum += Number((r as any).tokens || 0);
      }
    }
    return sum;
  } catch {
    return 0;
  }
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
  const col = type === 'tags' ? 'tags' : 'respostas';
  const row = await db.get(`SELECT ${col} FROM usage WHERE plan = ? AND month = ?`, [plan, month]);
  const limit =
    plan === 'rei' || plan === 'corporativo'
      ? 20000
      : plan === 'ultra'
        ? 4000
        : 1500;
  if (row && Number((row as any)[col] || 0) >= limit) {
    throw new Error(`Limite mensal de ${type} para o plano ${plan} atingido`);
  }
  await db.run(
    `INSERT INTO usage (plan, month, ${col}) VALUES (?, ?, 1)
    ON CONFLICT(plan, month) DO UPDATE SET ${col} = usage.${col} + 1`,
    [plan, month]
  );
}

export async function contarReviewsMes(empresaId: string): Promise<number> {
  const db = getDb();
  const mes = getCurrentMonth();
  try {
    const rows = await db.all(
      `SELECT "createdAt" AS c FROM reviews WHERE empresa_id = ? LIMIT 5000`,
      [empresaId]
    );
    return (rows || []).filter((r: any) => monthPrefix(r.c) === mes).length;
  } catch {
    try {
      const rows = await db.all(
        `SELECT createdAt AS c FROM reviews WHERE empresa_id = ? LIMIT 5000`,
        [empresaId]
      );
      return (rows || []).filter((r: any) => monthPrefix(r.c) === mes).length;
    } catch {
      try {
        const row = await db.get(
          `SELECT COUNT(*) as c FROM reviews WHERE empresa_id = ?`,
          [empresaId]
        );
        return Number((row as any)?.c || 0);
      } catch {
        return 0;
      }
    }
  }
}
