/**
 * Identificação fiscal da empresa.
 * - Brasil: CNPJ (14 dígitos + dígitos verificadores)
 * - Internacional: Tax ID alfanumérico (VAT, NIF, EIN, etc.) — 5 a 32 chars
 */

export function normalizarCnpj(cnpj: string): string {
  return String(cnpj || '').replace(/\D/g, '');
}

/** Normaliza CNPJ (só dígitos) ou Tax ID internacional (A-Z0-9). */
export function normalizarTaxId(raw: string): string {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  if (digits.length === 14 && /^[\d.\/\-\s]+$/.test(s.replace(/\s/g, ''))) {
    return digits;
  }
  // Se for exatamente 14 dígitos sem letras, trata como CNPJ
  if (/^\d{14}$/.test(digits) && !/[A-Za-z]/.test(s)) {
    return digits;
  }
  return s.replace(/[^A-Z0-9]/g, '').slice(0, 32);
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

/** Aceita CNPJ BR válido ou Tax ID internacional (5–32 alfanuméricos). */
export function taxIdValido(raw: string): boolean {
  const n = normalizarTaxId(raw);
  if (!n) return false;
  if (/^\d{14}$/.test(n)) return cnpjValido(n);
  return n.length >= 5 && n.length <= 32 && /^[A-Z0-9]+$/.test(n);
}
