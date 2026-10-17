/** Planos oficiais do produto + flags de recurso. */

export const PLANOS_OFICIAIS = ['inicial', 'pro', 'ultra', 'corporativo', 'rei'] as const;
export type PlanoOficial = (typeof PLANOS_OFICIAIS)[number];

export function isPlanoOficial(p: string): p is PlanoOficial {
  return (PLANOS_OFICIAIS as readonly string[]).includes(String(p || '').toLowerCase());
}

/**
 * Normaliza aliases de plano para o código canônico usado nas regras de negócio.
 * `corp` e `corporate` são o mesmo plano `corporativo` (ver billingService) e
 * precisam valer o mesmo acesso em todas as trilhas (Dot, cotas, relatórios).
 */
export function normalizePlanAlias(plan: string | null | undefined): string {
  const p = String(plan || '').toLowerCase().trim();
  if (p === 'corp' || p === 'corporate') return 'corporativo';
  return p;
}

/**
 * Troca de planos por teste (sem Stripe).
 * Produção: SEMPRE desligado — a env ALLOW_PLAN_SWITCH é ignorada.
 * Fora de produção: ligado por padrão; ALLOW_PLAN_SWITCH=0/false desliga.
 */
export function allowPlanSwitch(): boolean {
  if (String(process.env.NODE_ENV || '') === 'production') return false;
  const v = String(process.env.ALLOW_PLAN_SWITCH || '').trim().toLowerCase();
  if (v === '0' || v === 'false') return false;
  return true;
}

export function isTrialPlan(plan: string | null | undefined): boolean {
  const p = String(plan || '').toLowerCase().trim();
  return p === 'trial' || p === 'teste' || p === 'test';
}

/** Relatório profissional mensal: Pro, Ultra, Corporativo e REI. */
export function planTemRelatorioMensal(plan: string | null | undefined): boolean {
  const normalized = String(plan || '').toLowerCase().trim();
  return ['pro', 'ultra', 'corporativo', 'corporate', 'corp', 'rei'].includes(normalized);
}

export function planTemPdf(plan: string | null | undefined): boolean {
  const p = String(plan || '').toLowerCase().trim();
  if (!p) return false;
  if (isTrialPlan(p)) return true;
  if (['pro', 'ultra', 'corporativo', 'rei'].includes(p)) return true;
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

export function empresaTemPdf(empresa: {
  plan?: string | null;
  status?: string | null;
}): boolean {
  if (planTemPdf(empresa?.plan)) return true;
  const st = String(empresa?.status || '').toLowerCase().trim();
  if (st === 'trial' || st === 'teste' || st === 'test') return true;
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
