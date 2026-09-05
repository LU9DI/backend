/** Validação e normalização de CNPJ (Brasil). */

export function normalizarCnpj(cnpj: string): string {
  return String(cnpj || '').replace(/\D/g, '');
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
