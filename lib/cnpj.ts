/**
 * Identificador fiscal: CNPJ BR (14 dígitos) ou tax_id internacional.
 */

export function normalizarCnpj(cnpj: string): string {
  return String(cnpj || '').replace(/\D/g, '');
}

/** Só dígitos — validação de dígitos verificadores BR. */
export function cnpjValido(cnpjRaw: string): boolean {
  const cnpj = normalizarCnpj(cnpjRaw);
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;

  const calc = (base: string, pesoInicial: number): number => {
    let soma = 0;
    let peso = pesoInicial;
    for (let i = 0; i < base.length; i++) {
      soma += parseInt(base[i], 10) * peso;
      peso = peso === 2 ? 9 : peso - 1;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  const d1 = calc(cnpj.slice(0, 12), 5);
  const d2 = calc(cnpj.slice(0, 12) + String(d1), 6);
  return parseInt(cnpj[12], 10) === d1 && parseInt(cnpj[13], 10) === d2;
}

/**
 * Normaliza tax_id para trial/login:
 * - CNPJ BR válido → 14 dígitos
 * - vazio → INTL-{uuid curto} (estrangeiro)
 * - outro alfanumérico 5–32 → upper
 */
export function normalizarTaxId(raw: string | null | undefined): string {
  const s = String(raw || '').trim();
  if (!s) {
    return `INTL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
  }
  const digits = s.replace(/\D/g, '');
  if (digits.length === 14 && cnpjValido(digits)) return digits;
  const alnum = s.replace(/[^a-zA-Z0-9\-]/g, '').toUpperCase();
  if (alnum.length >= 5 && alnum.length <= 32) return alnum;
  if (digits.length >= 8 && digits.length <= 20) return digits;
  return `INTL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
}

export function taxIdValido(raw: string | null | undefined, { required = false } = {}): boolean {
  const s = String(raw || '').trim();
  if (!s) return !required;
  const digits = s.replace(/\D/g, '');
  if (digits.length === 14) return cnpjValido(digits);
  const alnum = s.replace(/[^a-zA-Z0-9\-]/g, '');
  return alnum.length >= 5 && alnum.length <= 32;
}
