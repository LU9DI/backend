/**
 * WhatsApp: normalização e textos pré-preenchidos.
 *
 * Dois sentidos:
 * 1) EMPRESA → cliente (botão no painel)
 * 2) CLIENTE → empresa (após crítica, falar com a loja)
 */

export function normalizarWhatsapp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;
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
  if (!texto?.trim()) return base;
  return `${base}?text=${encodeURIComponent(texto.trim())}`;
}

/** EMPRESA abre o WhatsApp do cliente (painel). */
export function mensagemEmpresaParaCliente(opts: {
  nomeEmpresa?: string;
  nomeCliente?: string;
  rating?: number;
  comment?: string;
}): string {
  const empresa = (opts.nomeEmpresa || 'nossa equipe').trim();
  const cliente =
    opts.nomeCliente && opts.nomeCliente !== 'Anônimo'
      ? opts.nomeCliente.trim()
      : '';
  const saudacao = cliente ? `Olá, ${cliente}!` : 'Olá!';
  const linhas = [
    saudacao,
    '',
    `Aqui é da equipe de ${empresa}. Recebemos seu feedback privado e gostaríamos de entender melhor o que aconteceu para resolver.`,
  ];
  if (opts.rating != null && opts.rating >= 1 && opts.rating <= 5) {
    linhas.push('', `Referência: avaliação ${opts.rating}★ (somente interna).`);
  }
  if (opts.comment?.trim()) {
    linhas.push('', `Você comentou: “${opts.comment.trim().slice(0, 200)}”`);
  }
  linhas.push('', 'Pode nos contar um pouco mais por aqui? Obrigado.');
  return linhas.join('\n');
}

/**
 * CLIENTE abre o WhatsApp da empresa (após avaliação negativa).
 * Mensagem simples: não ficou satisfeito com o atendimento.
 */
export function mensagemClienteParaEmpresa(opts: {
  nomeEmpresa?: string;
  nomeCliente?: string;
  rating?: number;
  comment?: string;
}): string {
  const empresa = (opts.nomeEmpresa || 'vocês').trim();
  const cliente =
    opts.nomeCliente && opts.nomeCliente !== 'Anônimo'
      ? String(opts.nomeCliente).trim()
      : '';

  // Texto curto e direto — o cliente só envia
  const linhas = [
    `Olá, ${empresa}!`,
    '',
    'Acabei de registrar um feedback pelo link de avaliação e não fiquei satisfeito com o atendimento.',
  ];

  if (opts.comment?.trim()) {
    linhas.push('', `O que aconteceu: ${opts.comment.trim().slice(0, 280)}`);
  }

  linhas.push('', 'Gostaria de conversar para resolver isso.');

  if (cliente) {
    linhas.push('', `— ${cliente}`);
  }

  return linhas.join('\n');
}

/** @deprecated Preferir mensagemEmpresaParaCliente / mensagemClienteParaEmpresa */
export function mensagemPosCritica(opts: {
  nomeEmpresa?: string;
  nomeCliente?: string;
  rating: number;
  comment?: string;
}): string {
  return mensagemClienteParaEmpresa(opts);
}
