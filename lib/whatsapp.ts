/**
 * Normaliza telefone para wa.me e monta textos de mensagem.
 *
 * Importante:
 * - Ao abrir o WhatsApp do **cliente** (painel da empresa), a mensagem é da
 *   EMPRESA → cliente (contato sobre a crítica privada).
 * - NÃO usar rascunho de “pedir desculpas à empresa” nem texto como se o
 *   cliente estivesse mandando feedback de novo.
 */

export function normalizarWhatsapp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  // BR sem DDI (10/11 dígitos)
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

/**
 * Texto quando a **empresa** abre o WhatsApp do cliente (painel).
 * Tom: contato profissional sobre o feedback privado — sem “pedir desculpas
 * para a empresa” e sem repetir o formulário de avaliação.
 */
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
 * Texto opcional se o **cliente** for direcionado ao WhatsApp da empresa
 * logo após enviar a crítica (não é o fluxo principal do painel).
 */
export function mensagemClienteParaEmpresa(opts: {
  nomeEmpresa?: string;
  nomeCliente?: string;
  rating: number;
  comment?: string;
}): string {
  const empresa = opts.nomeEmpresa || 'vocês';
  const cliente =
    opts.nomeCliente && opts.nomeCliente !== 'Anônimo' ? opts.nomeCliente : 'Cliente';
  const linhas = [
    `Olá! Enviei um feedback privado (${opts.rating}★) sobre ${empresa} pelo link de avaliação.`,
  ];
  if (opts.comment?.trim()) {
    linhas.push('', `Resumo: ${opts.comment.trim().slice(0, 300)}`);
  }
  linhas.push('', `Fico à disposição.`, `— ${cliente}`);
  return linhas.join('\n');
}

/** @deprecated Use mensagemEmpresaParaCliente ou mensagemClienteParaEmpresa */
export function mensagemPosCritica(opts: {
  nomeEmpresa?: string;
  nomeCliente?: string;
  rating: number;
  comment?: string;
}): string {
  // Compat: quem usava isso no botão “falar com cliente” deve preferir empresa→cliente
  return mensagemEmpresaParaCliente(opts);
}
