/**
 * Normaliza telefone para wa.me (somente dígitos, com DDI 55 se BR sem DDI).
 */
export function normalizarWhatsapp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  // Se veio com 10/11 dígitos (BR sem DDI), prefixa 55
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  if (d.length < 12 || d.length > 15) return null;
  return d;
}

export function linkWhatsapp(
  telefone: string | null | undefined,
  texto?: string
): string | null {
  const num = normalizarWhatsapp(telefone);
  if (!num) return null;
  const base = `https://wa.me/${num}`;
  if (!texto) return base;
  return `${base}?text=${encodeURIComponent(texto)}`;
}

export function mensagemPosCritica(opts: {
  nomeEmpresa?: string;
  nomeCliente?: string;
  rating: number;
  comment?: string;
}): string {
  const empresa = opts.nomeEmpresa || 'a empresa';
  const cliente = opts.nomeCliente && opts.nomeCliente !== 'Anônimo' ? opts.nomeCliente : 'Cliente';
  const linhas = [
    `Olá! Acabei de enviar um feedback (${opts.rating}★) sobre ${empresa}.`,
  ];
  if (opts.comment?.trim()) {
    linhas.push('', `Resumo: ${opts.comment.trim().slice(0, 300)}`);
  }
  linhas.push('', `— ${cliente}`);
  return linhas.join('\n');
}
