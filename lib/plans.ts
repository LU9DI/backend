/** Planos oficiais do produto + flags de recurso. */

export const PLANOS_OFICIAIS = ['inicial', 'pro', 'ultra', 'corporativo', 'rei'] as const;
export type PlanoOficial = (typeof PLANOS_OFICIAIS)[number];

export function isPlanoOficial(p: string): p is PlanoOficial {
  return (PLANOS_OFICIAIS as readonly string[]).includes(String(p || '').toLowerCase());
}

/** Só liga com ALLOW_PLAN_SWITCH=1. Em produção o default é OFF. */
export function allowPlanSwitch(): boolean {
  const v = String(process.env.ALLOW_PLAN_SWITCH || '').trim();
  if (v === '1' || v.toLowerCase() === 'true') return true;
  if (v === '0' || v.toLowerCase() === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

export function isTrialPlan(plan: string | null | undefined): boolean {
  const p = String(plan || '').toLowerCase().trim();
  return p === 'trial' || p === 'teste' || p === 'test';
}

export function planTemPdf(_plan: string | null | undefined): boolean {
  return false;
}

/** Relatório inteligente (texto → n8n). Inicial NÃO tem. Trial e Pro+ sim. */
export function planTemRelatorio(plan: string | null | undefined): boolean {
  const p = String(plan || '').toLowerCase().trim();
  if (!p) return false;
  if (p === 'inicial') return false;
  if (isTrialPlan(p)) return true;
  if (['pro', 'ultra', 'corporativo', 'rei'].includes(p)) return true;
  return false;
}

/** Compatibilidade legada: nenhuma empresa recebe PDF novo. */
export function empresaTemPdf(_empresa: { plan?: string | null; status?: string | null }): boolean {
  return false;
}

export function empresaTemRelatorio(empresa: {
  plan?: string | null;
  status?: string | null;
}): boolean {
  if (planTemRelatorio(empresa?.plan)) return true;
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
