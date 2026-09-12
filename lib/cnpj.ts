/**
 * Identificador fiscal da empresa.
 * - Brasil: CNPJ (14 dígitos + DV)
 * - Exterior: Tax ID alfanumérico (5–20 chars)
 * Coluna no banco continua `cnpj` por compatibilidade.
 */

export function normalizarCnpj(cnpj: string): string {
  return String(cnpj || '').replace(/\D/g, '');
}

export function normalizarTaxId(raw: string): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

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

export function taxIdValido(raw: string): boolean {
  const digits = normalizarCnpj(raw);
  if (digits.length === 14 && /^\d{14}$/.test(digits)) {
    return cnpjValido(digits);
  }
  const tax = normalizarTaxId(raw);
  if (tax.length < 5 || tax.length > 20) return false;
  if (/^\d+$/.test(tax) && tax.length === 14) return cnpjValido(tax);
  return true;
}

export function canonicalTaxId(raw: string): string {
  const digits = normalizarCnpj(raw);
  if (digits.length === 14 && cnpjValido(digits)) return digits;
  return normalizarTaxId(raw);
}

export function isEmailLike(raw: string): boolean {
  const s = String(raw || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
