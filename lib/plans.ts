/** Planos oficiais do produto + flags de recurso. */

export const PLANOS_OFICIAIS = ['inicial', 'pro', 'ultra', 'corporativo', 'rei'] as const;
export type PlanoOficial = (typeof PLANOS_OFICIAIS)[number];

export function isPlanoOficial(p: string): p is PlanoOficial {
  return (PLANOS_OFICIAIS as readonly string[]).includes(String(p || '').toLowerCase());
}

/** Em dev (ou ALLOW_PLAN_SWITCH=1) o cliente pode alternar plano sem Stripe. */
export function allowPlanSwitch(): boolean {
  if (process.env.ALLOW_PLAN_SWITCH === '0') return false;
  if (process.env.ALLOW_PLAN_SWITCH === '1') return true;
  return process.env.NODE_ENV !== 'production';
}

/** Trial / teste de 7 dias — tudo incluso (IA, PDF, dashboard completo). */
export function isTrialPlan(plan: string | null | undefined): boolean {
  const p = String(plan || '').toLowerCase().trim();
  return p === 'trial' || p === 'teste' || p === 'test';
}

/**
 * PDF mensal liberado para:
 * - trial/teste (7 dias — tudo incluso)
 * - pro, ultra, corporativo, rei
 * Inicial pago NÃO tem PDF.
 */
export function planTemPdf(plan: string | null | undefined): boolean {
  const p = String(plan || '').toLowerCase().trim();
  if (!p) return false;
  if (isTrialPlan(p)) return true;
  if (['pro', 'ultra', 'corporativo', 'rei'].includes(p)) return true;
  return false;
}

/**
 * Libera PDF olhando plan E status (empresa em trial às vezes tem plan vazio/antigo).
 */
export function empresaTemPdf(empresa: {
  plan?: string | null;
  status?: string | null;
}): boolean {
  if (planTemPdf(empresa?.plan)) return true;
  const st = String(empresa?.status || '').toLowerCase().trim();
  if (st === 'trial' || st === 'teste' || st === 'test') return true;
  return false;
}

export function planLabel(plan: string): string {
  const map: Record<string, string> = {
    trial: 'Trial',
    teste: 'Teste',
    test: 'Teste',
    inicial: 'Inicial',
    pro: 'Pro',
    ultra: 'Ultra',
    corporativo: 'Corporativo',
    rei: 'Rei',
  };
  return map[String(plan || '').toLowerCase()] || String(plan || '—');
}
