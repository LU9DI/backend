/**
 * Contato B2B por legítimo interesse (LGPD art. 7º, IX), restrito a empresas.
 *
 * Desligado por padrão: só funciona com ACQUISITION_LEGIT_INTEREST=1.
 * Salvaguardas: apenas e-mail corporativo publicado pela própria empresa
 * (base 'b2b_public_prospect'), nunca provedor gratuito/pessoal, nunca órgão
 * público, teto diário próprio e baixo, e a mensagem informa a origem do
 * contato, a base legal e como cancelar.
 */
export const LEGIT_BASIS = 'b2b_public_prospect';

const FREE_MAIL = /@(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|bol|uol|terra|ig|globo|globomail|zipmail|r7|proton|protonmail|aol|gmx|mail)\./i;
const PUBLIC_BODY = /(\.gov\.br|\.jus\.br|\.leg\.br|\.mil\.br|\.mp\.br|\.edu\.br|(^|[@.])(usp|unicamp|unesp|ufg|ufmg|ufrj|ufsc|ufpr|unb|ifg|fatec|etec|cps)\.(br|sp\.gov\.br))$/i;
// Entes públicos e instituições de ensino/saúde públicas: fora do legítimo interesse comercial.
const PUBLIC_NAME = /(prefeitura|c[aâ]mara municipal|secretaria (municipal|estadual)|centro municipal|cl[ií]nica da fam[ií]lia|\bubs\b|\bupa\b|posto de sa[uú]de|hospital (municipal|estadual|federal|militar)|escola (estadual|municipal|t[eé]cnica)|\betec\b|\bfatec\b|universidade|instituto federal|consulado|embaixada|cart[oó]rio|delegacia|pol[ií]cia|corpo de bombeiros)/i;

export function legitInterestEnabled(): boolean {
  return String(process.env.ACQUISITION_LEGIT_INTEREST || '').trim() === '1';
}

export function legitDailyCap(): number {
  const n = Number(process.env.ACQUISITION_LEGIT_DAILY_CAP || 10);
  return Math.min(30, Math.max(1, Number.isFinite(n) ? Math.floor(n) : 10));
}

/** E-mail corporativo: domínio próprio, não provedor gratuito e não órgão público. */
export function isCorporateEmail(email: unknown): boolean {
  const e = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return false;
  if (FREE_MAIL.test(e)) return false;
  if (PUBLIC_BODY.test(e)) return false;
  return true;
}

/** O lead pode receber o primeiro contato por legítimo interesse? */
export function canContactByLegitimateInterest(lead: { nome_empresa?: unknown; email?: unknown; acquisition_contact_basis?: unknown; acquisition_opted_in_at?: unknown }): boolean {
  if (!legitInterestEnabled()) return false;
  if (lead.acquisition_opted_in_at) return false; // quem tem opt-in segue o fluxo normal
  if (PUBLIC_NAME.test(String(lead.nome_empresa || ''))) return false;
  return String(lead.acquisition_contact_basis || '') === LEGIT_BASIS && isCorporateEmail(lead.email);
}
