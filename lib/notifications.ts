/**
 * Notificações automáticas por e-mail (SMTP via mailer).
 * Sem SMTP configurado, o conteúdo vai para o console (dev).
 */
import { enviarEmail, smtpConfigured } from './mailer.js';

const APP_URL = (process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(
  /\/$/,
  ''
);
const BRAND = process.env.BRAND_NAME || 'Filtra.IA';

export type Locale = 'pt' | 'en' | 'es';

function normLocale(raw?: string | null): Locale {
  const l = String(raw || 'pt').toLowerCase().slice(0, 2);
  if (l === 'en' || l === 'es') return l;
  return 'pt';
}

function fmtDate(iso: string, locale: Locale): string {
  try {
    return new Date(iso).toLocaleString(
      locale === 'en' ? 'en-US' : locale === 'es' ? 'es-ES' : 'pt-BR',
      { dateStyle: 'medium', timeStyle: 'short' }
    );
  } catch {
    return iso;
  }
}

function wrapHtml(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${title}</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#e4e4e7;margin:0;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#18181b;border:1px solid #27272a;border-radius:16px;padding:28px">
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#71717a">${BRAND}</p>
    <h1 style="margin:0 0 16px;font-size:20px;color:#fafafa">${title}</h1>
    <div style="font-size:14px;line-height:1.55;color:#a1a1aa">${bodyHtml}</div>
    <p style="margin:28px 0 0;font-size:12px;color:#52525b">— ${BRAND}</p>
  </div>
</body></html>`;
}

/** Trial ativado com sucesso */
export async function notificarTrialAtivado(opts: {
  email: string;
  nomeEmpresa: string;
  slug?: string;
  empresaId?: string;
  expiraEm: string;
  locale?: string;
}): Promise<void> {
  if (!opts.email) return;
  const locale = normLocale(opts.locale);
  const ref = opts.slug || opts.empresaId || '';
  const painel = `${APP_URL}/painel/${ref}`;
  const avaliacao = `${APP_URL}/avaliacao/${ref}`;
  const exp = fmtDate(opts.expiraEm, locale);

  const copy =
    locale === 'en'
      ? {
          subject: `${BRAND} — trial activated for ${opts.nomeEmpresa}`,
          text: [
            `Hi,`,
            ``,
            `Your 7-day trial for ${opts.nomeEmpresa} is active.`,
            `Expires: ${exp}`,
            ``,
            `Dashboard: ${painel}`,
            `Review link: ${avaliacao}`,
            ``,
            `Share the review link (QR or URL) with customers. Negative feedback stays private.`,
          ].join('\n'),
          html: wrapHtml(
            'Trial activated',
            `<p>Your 7-day trial for <strong style="color:#fafafa">${opts.nomeEmpresa}</strong> is active.</p>
             <p>Expires: <strong style="color:#fafafa">${exp}</strong></p>
             <p><a href="${painel}" style="color:#818cf8">Open dashboard</a> · <a href="${avaliacao}" style="color:#818cf8">Review link</a></p>`
          ),
        }
      : locale === 'es'
        ? {
            subject: `${BRAND} — prueba activada para ${opts.nomeEmpresa}`,
            text: [
              `Hola,`,
              ``,
              `Tu prueba de 7 días para ${opts.nomeEmpresa} está activa.`,
              `Expira: ${exp}`,
              ``,
              `Panel: ${painel}`,
              `Enlace de evaluación: ${avaliacao}`,
            ].join('\n'),
            html: wrapHtml(
              'Prueba activada',
              `<p>Tu prueba de 7 días para <strong style="color:#fafafa">${opts.nomeEmpresa}</strong> está activa.</p>
               <p>Expira: <strong style="color:#fafafa">${exp}</strong></p>
               <p><a href="${painel}" style="color:#818cf8">Abrir panel</a></p>`
            ),
          }
        : {
            subject: `${BRAND} — trial ativado para ${opts.nomeEmpresa}`,
            text: [
              `Olá,`,
              ``,
              `Seu período de 7 dias grátis de ${opts.nomeEmpresa} está ativo.`,
              `Expira em: ${exp}`,
              ``,
              `Painel: ${painel}`,
              `Link de avaliação: ${avaliacao}`,
              ``,
              `Compartilhe o link (ou QR) com clientes. Críticas ≤3★ ficam privadas e você recebe alerta.`,
            ].join('\n'),
            html: wrapHtml(
              'Trial ativado',
              `<p>Seu período de 7 dias grátis de <strong style="color:#fafafa">${opts.nomeEmpresa}</strong> está ativo.</p>
               <p>Expira em: <strong style="color:#fafafa">${exp}</strong></p>
               <p><a href="${painel}" style="color:#818cf8">Abrir painel</a> · <a href="${avaliacao}" style="color:#818cf8">Link de avaliação</a></p>
               <p style="margin-top:12px">Compartilhe o link com clientes. Críticas ficam privadas e geram alerta por e-mail.</p>`
            ),
          };

  await enviarEmail({
    to: opts.email,
    subject: copy.subject,
    text: copy.text,
    html: copy.html,
  });
}

/** Nova crítica privada (rating ≤ 3) */
export async function notificarCriticaPrivada(opts: {
  email: string;
  nomeEmpresa: string;
  nomeCliente?: string;
  rating: number;
  comment?: string;
  aiReply?: string | null;
  clientWhatsapp?: string | null;
  slug?: string;
  empresaId?: string;
  locale?: string;
}): Promise<void> {
  if (!opts.email || opts.rating > 3) return;
  const locale = normLocale(opts.locale);
  const ref = opts.slug || opts.empresaId || '';
  const painel = `${APP_URL}/painel/${ref}`;
  const cliente = opts.nomeCliente && opts.nomeCliente !== 'Anônimo' ? opts.nomeCliente : 'Cliente';
  const stars = '★'.repeat(Math.min(5, Math.max(1, opts.rating)));
  const comentario = (opts.comment || '').trim().slice(0, 500);
  const wa =
    opts.clientWhatsapp && String(opts.clientWhatsapp).replace(/\D/g, '').length >= 10
      ? `https://wa.me/${String(opts.clientWhatsapp).replace(/\D/g, '')}`
      : null;

  const copy =
    locale === 'en'
      ? {
          subject: `${BRAND} — private ${opts.rating}★ feedback · ${opts.nomeEmpresa}`,
          text: [
            `New private feedback for ${opts.nomeEmpresa}`,
            ``,
            `${cliente} · ${stars} (${opts.rating}/5)`,
            comentario ? `Comment: ${comentario}` : '',
            opts.aiReply ? `AI draft reply: ${opts.aiReply}` : '',
            wa ? `Customer WhatsApp: ${wa}` : '',
            ``,
            `Open dashboard: ${painel}`,
          ]
            .filter(Boolean)
            .join('\n'),
        }
      : {
          subject: `${BRAND} — feedback privado ${opts.rating}★ · ${opts.nomeEmpresa}`,
          text: [
            `Nova crítica privada em ${opts.nomeEmpresa}`,
            ``,
            `${cliente} · ${stars} (${opts.rating}/5)`,
            comentario ? `Comentário: ${comentario}` : '',
            opts.aiReply ? `Rascunho IA: ${opts.aiReply}` : '',
            wa ? `WhatsApp do cliente: ${wa}` : '',
            ``,
            `Abrir painel: ${painel}`,
          ]
            .filter(Boolean)
            .join('\n'),
        };

  await enviarEmail({
    to: opts.email,
    subject: copy.subject,
    text: copy.text,
    html: wrapHtml(
      locale === 'en' ? 'Private feedback' : 'Feedback privado',
      `<p><strong style="color:#fafafa">${cliente}</strong> · ${stars} (${opts.rating}/5)</p>
       ${comentario ? `<p style="color:#e4e4e7">“${comentario.replace(/</g, '')}”</p>` : ''}
       ${opts.aiReply ? `<p><em>IA:</em> ${String(opts.aiReply).replace(/</g, '')}</p>` : ''}
       ${wa ? `<p><a href="${wa}" style="color:#34d399">WhatsApp do cliente</a></p>` : ''}
       <p style="margin-top:16px"><a href="${painel}" style="color:#818cf8">Abrir painel</a></p>`
    ),
  });
}

/** Várias críticas graves em 24h */
export async function notificarAlertaCrise(opts: {
  email: string;
  nomeEmpresa: string;
  quantidade: number;
  slug?: string;
  empresaId?: string;
  locale?: string;
}): Promise<void> {
  if (!opts.email || opts.quantidade < 3) return;
  const locale = normLocale(opts.locale);
  const ref = opts.slug || opts.empresaId || '';
  const painel = `${APP_URL}/painel/${ref}`;

  const subject =
    locale === 'en'
      ? `${BRAND} — crisis alert: ${opts.quantidade} low ratings (24h)`
      : `${BRAND} — alerta de crise: ${opts.quantidade} notas baixas (24h)`;

  const text =
    locale === 'en'
      ? `${opts.nomeEmpresa} received ${opts.quantidade} ratings ≤2★ in the last 24 hours.\nOpen dashboard: ${painel}`
      : `${opts.nomeEmpresa} recebeu ${opts.quantidade} notas ≤2★ nas últimas 24 horas.\nAbrir painel: ${painel}`;

  await enviarEmail({
    to: opts.email,
    subject,
    text,
    html: wrapHtml(
      locale === 'en' ? 'Crisis alert' : 'Alerta de crise',
      `<p><strong style="color:#f87171">${opts.quantidade}</strong> avaliações ≤2★ nas últimas 24h em <strong style="color:#fafafa">${opts.nomeEmpresa}</strong>.</p>
       <p><a href="${painel}" style="color:#818cf8">Abrir painel agora</a></p>`
    ),
  });
}

/** Trial perto do fim (1–2 dias) */
export async function notificarTrialExpirando(opts: {
  email: string;
  nomeEmpresa: string;
  expiraEm: string;
  dias: number;
  slug?: string;
  empresaId?: string;
  locale?: string;
}): Promise<{ ok: boolean }> {
  if (!opts.email) return { ok: false };
  const locale = normLocale(opts.locale);
  const planos = `${APP_URL}/#planos`;
  const exp = fmtDate(opts.expiraEm, locale);

  const subject =
    locale === 'en'
      ? `${BRAND} — trial ends in ${opts.dias} day(s)`
      : `${BRAND} — seu trial expira em ${opts.dias} dia(s)`;

  const text =
    locale === 'en'
      ? `The trial for ${opts.nomeEmpresa} ends on ${exp} (${opts.dias} day(s) left).\nChoose a plan: ${planos}`
      : `O trial de ${opts.nomeEmpresa} termina em ${exp} (faltam ${opts.dias} dia(s)).\nEscolha um plano: ${planos}`;

  await enviarEmail({
    to: opts.email,
    subject,
    text,
    html: wrapHtml(
      locale === 'en' ? 'Trial ending soon' : 'Trial acabando',
      `<p>O trial de <strong style="color:#fafafa">${opts.nomeEmpresa}</strong> termina em <strong style="color:#fafafa">${exp}</strong> (faltam ${opts.dias} dia(s)).</p>
       <p><a href="${planos}" style="color:#818cf8">Ver planos e continuar</a></p>`
    ),
  });
  return { ok: true };
}

/**
 * Assinatura paga expirando em breve (renovação ou cancel_at_period_end).
 * motivo: 'renovacao' | 'cancelamento'
 */
export async function notificarAssinaturaExpirando(opts: {
  email: string;
  nomeEmpresa: string;
  plano?: string;
  expiraEm: string;
  dias: number;
  motivo?: 'renovacao' | 'cancelamento';
  slug?: string;
  empresaId?: string;
  locale?: string;
}): Promise<{ ok: boolean }> {
  if (!opts.email) return { ok: false };
  const locale = normLocale(opts.locale);
  const ref = opts.slug || opts.empresaId || '';
  const painel = `${APP_URL}/painel/${ref}`;
  const planos = `${APP_URL}/#planos`;
  const exp = fmtDate(opts.expiraEm, locale);
  const cancelado = opts.motivo === 'cancelamento';
  const planoLabel = opts.plano || 'atual';

  const subject = cancelado
    ? locale === 'en'
      ? `${BRAND} — access ends in ${opts.dias} day(s)`
      : `${BRAND} — acesso encerra em ${opts.dias} dia(s)`
    : locale === 'en'
      ? `${BRAND} — subscription renews in ${opts.dias} day(s)`
      : `${BRAND} — assinatura renova em ${opts.dias} dia(s)`;

  const text = cancelado
    ? locale === 'en'
      ? `You cancelled the plan ${planoLabel} for ${opts.nomeEmpresa}. Access remains until ${exp} (${opts.dias} day(s)).\nRenew: ${planos}`
      : `Você cancelou o plano ${planoLabel} de ${opts.nomeEmpresa}. O acesso segue até ${exp} (faltam ${opts.dias} dia(s)).\nRenovar: ${planos}`
    : locale === 'en'
      ? `The ${planoLabel} plan for ${opts.nomeEmpresa} renews on ${exp} (${opts.dias} day(s)).\nDashboard: ${painel}`
      : `O plano ${planoLabel} de ${opts.nomeEmpresa} renova em ${exp} (faltam ${opts.dias} dia(s)).\nPainel: ${painel}`;

  await enviarEmail({
    to: opts.email,
    subject,
    text,
    html: wrapHtml(
      cancelado
        ? locale === 'en'
          ? 'Access ending'
          : 'Acesso encerrando'
        : locale === 'en'
          ? 'Renewal soon'
          : 'Renovação próxima',
      cancelado
        ? `<p>Você cancelou o plano <strong style="color:#fafafa">${planoLabel}</strong> de <strong style="color:#fafafa">${opts.nomeEmpresa}</strong>.</p>
           <p>O uso permanece liberado até <strong style="color:#fafafa">${exp}</strong> (faltam ${opts.dias} dia(s)).</p>
           <p><a href="${planos}" style="color:#818cf8">Renovar assinatura</a></p>`
        : `<p>O plano <strong style="color:#fafafa">${planoLabel}</strong> de <strong style="color:#fafafa">${opts.nomeEmpresa}</strong> renova em <strong style="color:#fafafa">${exp}</strong> (faltam ${opts.dias} dia(s)).</p>
           <p><a href="${painel}" style="color:#818cf8">Abrir painel</a></p>`
    ),
  });
  return { ok: true };
}

/**
 * Acesso já encerrado (trial ou assinatura expirados / bloqueados).
 * tipo: 'trial' | 'assinatura' | 'cancelamento'
 */
export async function notificarAcessoExpirado(opts: {
  email: string;
  nomeEmpresa: string;
  tipo?: 'trial' | 'assinatura' | 'cancelamento';
  plano?: string;
  expiraEm?: string;
  slug?: string;
  empresaId?: string;
  locale?: string;
}): Promise<{ ok: boolean }> {
  if (!opts.email) return { ok: false };
  const locale = normLocale(opts.locale);
  const planos = `${APP_URL}/#planos`;
  const exp = opts.expiraEm ? fmtDate(opts.expiraEm, locale) : null;
  const tipo = opts.tipo || 'assinatura';

  const subject =
    locale === 'en'
      ? `${BRAND} — access ended for ${opts.nomeEmpresa}`
      : `${BRAND} — acesso encerrado · ${opts.nomeEmpresa}`;

  const intro =
    tipo === 'trial'
      ? locale === 'en'
        ? `The free trial for ${opts.nomeEmpresa} has ended.`
        : `O período grátis de ${opts.nomeEmpresa} terminou.`
      : tipo === 'cancelamento'
        ? locale === 'en'
          ? `Access for ${opts.nomeEmpresa} ended after the paid period.`
          : `O acesso de ${opts.nomeEmpresa} foi encerrado ao fim do período já pago.`
        : locale === 'en'
          ? `The subscription for ${opts.nomeEmpresa} has expired.`
          : `A assinatura de ${opts.nomeEmpresa} expirou.`;

  const text = [
    intro,
    exp ? (locale === 'en' ? `Ended on: ${exp}` : `Encerrado em: ${exp}`) : '',
    opts.plano ? (locale === 'en' ? `Plan: ${opts.plano}` : `Plano: ${opts.plano}`) : '',
    ``,
    locale === 'en' ? `Choose a plan to continue: ${planos}` : `Escolha um plano para continuar: ${planos}`,
  ]
    .filter(Boolean)
    .join('\n');

  await enviarEmail({
    to: opts.email,
    subject,
    text,
    html: wrapHtml(
      locale === 'en' ? 'Access ended' : 'Acesso encerrado',
      `<p>${intro}</p>
       ${exp ? `<p>Data: <strong style="color:#fafafa">${exp}</strong></p>` : ''}
       ${opts.plano ? `<p>Plano: <strong style="color:#fafafa">${opts.plano}</strong></p>` : ''}
       <p style="margin-top:16px"><a href="${planos}" style="color:#818cf8">Ver planos e reativar</a></p>`
    ),
  });
  return { ok: true };
}

/** Pagamento / upgrade confirmado (Stripe) */
export async function notificarPagamentoConfirmado(opts: {
  email: string;
  nomeEmpresa: string;
  plano: string;
  expiraEm?: string;
  slug?: string;
  empresaId?: string;
  locale?: string;
}): Promise<void> {
  if (!opts.email) return;
  const locale = normLocale(opts.locale);
  const ref = opts.slug || opts.empresaId || '';
  const painel = `${APP_URL}/painel/${ref}`;

  const subject =
    locale === 'en'
      ? `${BRAND} — plan ${opts.plano} active`
      : `${BRAND} — plano ${opts.plano} ativo`;

  const text =
    locale === 'en'
      ? `Payment confirmed for ${opts.nomeEmpresa}. Plan: ${opts.plano}.\nDashboard: ${painel}`
      : `Pagamento confirmado para ${opts.nomeEmpresa}. Plano: ${opts.plano}.\nPainel: ${painel}`;

  await enviarEmail({
    to: opts.email,
    subject,
    text,
    html: wrapHtml(
      locale === 'en' ? 'Plan active' : 'Plano ativo',
      `<p>Pagamento confirmado para <strong style="color:#fafafa">${opts.nomeEmpresa}</strong>.</p>
       <p>Plano: <strong style="color:#fafafa">${opts.plano}</strong></p>
       <p><a href="${painel}" style="color:#818cf8">Abrir painel</a></p>`
    ),
  });
}

/** Confirmação de cancelamento (acesso até o fim do ciclo pago) */
export async function notificarCancelamentoAgendado(opts: {
  email: string;
  nomeEmpresa: string;
  plano?: string;
  expiraEm?: string | null;
  slug?: string;
  empresaId?: string;
  locale?: string;
}): Promise<{ ok: boolean }> {
  if (!opts.email) return { ok: false };
  const locale = normLocale(opts.locale);
  const planos = `${APP_URL}/#planos`;
  const exp = opts.expiraEm ? fmtDate(opts.expiraEm, locale) : null;
  const planoLabel = opts.plano || 'atual';

  const subject =
    locale === 'en'
      ? `${BRAND} — cancellation scheduled · ${opts.nomeEmpresa}`
      : `${BRAND} — cancelamento agendado · ${opts.nomeEmpresa}`;

  const text =
    locale === 'en'
      ? `Cancellation confirmed for ${opts.nomeEmpresa} (${planoLabel}).${exp ? ` Access until ${exp}.` : ''}\nNo extra charge next cycle. Renew anytime: ${planos}`
      : `Cancelamento confirmado para ${opts.nomeEmpresa} (plano ${planoLabel}).${exp ? ` Acesso até ${exp}.` : ''}\nSem cobrança no próximo ciclo. Renove quando quiser: ${planos}`;

  await enviarEmail({
    to: opts.email,
    subject,
    text,
    html: wrapHtml(
      locale === 'en' ? 'Cancellation scheduled' : 'Cancelamento agendado',
      `<p>Cancelamento confirmado para <strong style="color:#fafafa">${opts.nomeEmpresa}</strong> (plano <strong style="color:#fafafa">${planoLabel}</strong>).</p>
       ${exp ? `<p>Você continua com acesso até <strong style="color:#fafafa">${exp}</strong> — último dia do período já pago.</p>` : ''}
       <p>Sem cobrança no mês seguinte.</p>
       <p><a href="${planos}" style="color:#818cf8">Renovar assinatura</a></p>`
    ),
  });
  return { ok: true };
}

export { smtpConfigured };
