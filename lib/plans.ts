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

/** Trial / teste de 7 dias — tudo incluso (IA, relatório, dashboard completo). */
export function isTrialPlan(plan: string | null | undefined): boolean {
  const p = String(plan || '').toLowerCase();
  return p === 'trial' || p === 'teste' || p === 'test';
}

/**
 * Relatório inteligente (texto → n8n → WhatsApp/SMS/e-mail/WeChat).
 * Trial + Pro e acima. Plano Inicial pago NÃO tem.
 */
export function planTemRelatorio(plan: string | null | undefined): boolean {
  const p = String(plan || '').toLowerCase();
  if (isTrialPlan(p)) return true;
  if (['pro', 'ultra', 'corporativo', 'rei'].includes(p)) return true;
  return false;
}

/** @deprecated use planTemRelatorio — mantido para rotas PDF legadas */
export function planTemPdf(plan: string | null | undefined): boolean {
  return planTemRelatorio(plan);
}

export function planLabel(plan: string): string {
  const map: Record<string, string> = {
    trial: 'Trial',
    teste: 'Teste',
    test: 'Trial',
    inicial: 'Inicial',
    pro: 'Pro',
    ultra: 'Ultra',
    corporativo: 'Corporativo',
    rei: 'Rei',
  };
  return map[String(plan || '').toLowerCase()] || String(plan || '—');
}
