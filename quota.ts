// Quota enforcement — limites oficiais de feedbacks/mês
// Inicial 150 | Pro 400 | Ultra 800 | Corporativo 2500 | Rei 80000
import { db } from './server.js';
import { getCurrentMonth } from './planUtils.js';

export const PLAN_FEEDBACK_LIMITS: Record<string, number> = {
  trial: 30,
  inicial: 150,
  pro: 400,
  ultra: 800,
  corporativo: 2500,
  rei: 80000,
};

/** Limite mensal de feedbacks/avaliações do plano */
export function getFeedbackLimit(plan: string): number {
  return PLAN_FEEDBACK_LIMITS[String(plan || 'teste').toLowerCase()] ?? PLAN_FEEDBACK_LIMITS.teste;
}

/** Verify IA usage quota for a given plan and type (tags or respostas) */
export async function checkQuota(plan: string, type: 'tags' | 'respostas'): Promise<void> {
  const month = getCurrentMonth();
  const row = await db.get(`SELECT ${type} FROM usage WHERE plan = ? AND month = ?`, [plan, month]);
  // Rei e Corporativo: teto alto de IA; demais planos proporcional aos feedbacks
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

