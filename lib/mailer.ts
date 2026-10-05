/**
 * Envio de e-mail: Resend (recomendado) ou SMTP (Gmail/etc).
 *
 * Preferência no Render:
 *   RESEND_API_KEY=re_xxxx
 *   SMTP_FROM=Filtra.IA <onboarding@resend.dev>   // ou domínio verificado
 *
 * Alternativa Gmail:
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=587
 *   SMTP_USER=seu@gmail.com
 *   SMTP_PASS=xxxxxxxxxxxxxxxx   // senha de APP (16 chars, sem aspas)
 *   SMTP_FROM=Filtra.IA <seu@gmail.com>
 */

function cleanEnv(v?: string | null): string {
  return String(v || '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

/** Senha de app Gmail vem com espaços na UI — remove todos. */
function smtpPass(): string {
  return cleanEnv(process.env.SMTP_PASS).replace(/\s+/g, '');
}

export function resendConfigured(): boolean {
  return Boolean(cleanEnv(process.env.RESEND_API_KEY));
}

export function smtpConfigured(): boolean {
  return !!(
    cleanEnv(process.env.SMTP_HOST) &&
    cleanEnv(process.env.SMTP_FROM) &&
    cleanEnv(process.env.SMTP_USER) &&
    smtpPass()
  );
}

/** True se algum provedor de e-mail está pronto. */
export function mailConfigured(): boolean {
  return resendConfigured() || smtpConfigured();
}

export type SendEmailResult = {
  ok: boolean;
  mode: 'resend' | 'smtp' | 'console' | 'error';
  messageId?: string;
  error?: string;
};

function defaultFrom(): string {
  return (
    cleanEnv(process.env.SMTP_FROM) ||
    cleanEnv(process.env.MAIL_FROM) ||
    'Filtra.IA <onboarding@resend.dev>'
  );
}

function buildTransport() {
  const port = Number(cleanEnv(process.env.SMTP_PORT) || '587');
  const host = cleanEnv(process.env.SMTP_HOST);
  const secure = port === 465 || cleanEnv(process.env.SMTP_SECURE) === '1';
  const user = cleanEnv(process.env.SMTP_USER);
  const pass = smtpPass();

  return {
    // Quando HOST/PORT são informados explicitamente, não use `service: gmail`.
    // O preset do Nodemailer pode sobrescrever o transporte e tirar o Render
    // do caminho SMTP 587 que foi configurado.
    host,
    port,
    secure,
    family: 4,
    auth: { user, pass },
    requireTLS: !secure && port === 587,
    tls: {
      minVersion: 'TLSv1.2' as const,
      rejectUnauthorized: cleanEnv(process.env.SMTP_TLS_REJECT) !== '0',
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 25_000,
    logger: cleanEnv(process.env.SMTP_DEBUG) === '1',
    debug: cleanEnv(process.env.SMTP_DEBUG) === '1',
  };
}

async function sendViaResend(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from: string;
  replyTo?: string;
  idempotencyKey?: string;
  headers?: Record<string, string>;
}): Promise<SendEmailResult> {
  const key = cleanEnv(process.env.RESEND_API_KEY);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: opts.from,
      to: [opts.to],
      subject: opts.subject,
      text: opts.text,
      html: opts.html || opts.text.replace(/\n/g, '<br/>'),
      ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
      ...(opts.headers && Object.keys(opts.headers).length ? { headers: opts.headers } : {}),
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err =
      (body as any)?.message ||
      (body as any)?.error ||
      `Resend HTTP ${res.status}`;
    console.error('[mail] Resend falhou:', err);
    return { ok: false, mode: 'error', error: String(err).slice(0, 300) };
  }

  const id = (body as any)?.id ? String((body as any).id) : undefined;
  console.log(`[mail] Resend OK to=${opts.to.replace(/(.{2}).+(@.+)/, '$1***$2')} id=${id || '?'}`);
  return { ok: true, mode: 'resend', messageId: id };
}

export async function verifySmtp(): Promise<SendEmailResult> {
  if (resendConfigured()) {
    return { ok: true, mode: 'resend' };
  }
  if (!smtpConfigured()) {
    return { ok: false, mode: 'error', error: 'SMTP incompleto e RESEND_API_KEY ausente' };
  }
  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.createTransport(buildTransport() as any);
    await transporter.verify();
    return { ok: true, mode: 'smtp' };
  } catch (e: any) {
    const msg = String(e?.message || e);
    console.error('[mail] verify falhou:', msg);
    return { ok: false, mode: 'error', error: msg.slice(0, 300) };
  }
}

export type MailPurpose = 'transactional' | 'acquisition' | 'admin_test';

export async function enviarEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  idempotencyKey?: string;
  purpose?: MailPurpose;
  acquisitionContactBasis?: string;
  headers?: Record<string, string>;
}): Promise<SendEmailResult> {
  const purpose = opts.purpose || 'transactional';
  const b2bPublicProspect = purpose === 'acquisition' && opts.acquisitionContactBasis === 'b2b_public_prospect';
  if (purpose === 'acquisition' && cleanEnv(process.env.ACQUISITION_ENGINE) !== '1') {
    const error = 'acquisition_email bloqueado: ACQUISITION_ENGINE não está habilitado';
    console.warn(`[mail] ${error}`);
    return { ok: false, mode: 'error', error };
  }
  // Captação precisa de um Reply-To real: o remetente padrão não recebe
  // respostas, então sem isso o pedido de descadastro por resposta se perde.
  const replyTo = purpose === 'acquisition' ? cleanEnv(process.env.ACQUISITION_REPLY_TO) : '';
  if (purpose === 'acquisition' && !replyTo) {
    const error = 'acquisition_email bloqueado: ACQUISITION_REPLY_TO não configurado';
    console.warn(`[mail] ${error}`);
    return { ok: false, mode: 'error', error };
  }
  const from = defaultFrom();
  const to = String(opts.to || '').trim().toLowerCase();

  if (!to || !to.includes('@')) {
    console.error('[mail] destinatário inválido');
    return { ok: false, mode: 'error', error: 'destinatário inválido' };
  }

  // 1) Resend primeiro (mais confiável em cloud)
  if (resendConfigured() && !b2bPublicProspect) {
    try {
      return await sendViaResend({ ...opts, to, from, replyTo: replyTo || undefined, idempotencyKey: opts.idempotencyKey });
    } catch (e: any) {
      console.error('[mail] Resend exception:', e?.message || e);
      // cai no SMTP se existir
      if (!smtpConfigured()) {
        return { ok: false, mode: 'error', error: String(e?.message || e).slice(0, 300) };
      }
    }
  }

  if (!smtpConfigured()) {
    console.warn('[mail] Sem RESEND_API_KEY e SMTP incompleto');
    console.log('────────────────────────────────────────────');
    console.log('📧 E-mail NÃO enviado. Para:', to, 'Assunto:', opts.subject);
    console.log(opts.text);
    console.log('────────────────────────────────────────────');
    return { ok: false, mode: 'console', error: 'Nenhum provedor de e-mail configurado' };
  }

  try {
    const nodemailer = await import('nodemailer');
    const transport = buildTransport();
    const transporter = nodemailer.createTransport(transport as any);

    console.log(
      `[mail] SMTP tentativa host=${transport.host} port=${transport.port} secure=${transport.secure}`
    );

    const info = await transporter.sendMail({
      from,
      to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html || opts.text.replace(/\n/g, '<br/>'),
      ...(replyTo ? { replyTo } : {}),
      headers: { 'X-Mailer': 'Filtra.IA' },
    });

    const messageId = info?.messageId ? String(info.messageId) : undefined;
    const accepted = Array.isArray(info?.accepted) ? info.accepted.length : 0;
    const rejected = Array.isArray(info?.rejected) ? info.rejected : [];
    console.log(
      `[mail] SMTP OK to=${to.replace(/(.{2}).+(@.+)/, '$1***$2')} id=${messageId || '?'} accepted=${accepted}`
    );
    if (rejected.length) {
      return { ok: false, mode: 'error', error: `rejeitado: ${rejected.join(',')}` };
    }
    return { ok: true, mode: 'smtp', messageId };
  } catch (e: any) {
    const msg = String(e?.message || e);
    console.error('[mail] FALHA SMTP:', msg);
    if (/Invalid login|Authentication|535|534|EAUTH/i.test(msg)) {
      console.error(
        '[mail] AUTH Gmail: 1) 2FA ligado 2) Senha de APP (16 chars) em SMTP_PASS 3) SMTP_FROM = mesmo e-mail do USER. Ou use RESEND_API_KEY.'
      );
    }
    return { ok: false, mode: 'error', error: msg.slice(0, 300) };
  }
}


/** Gateway dedicado para e-mails de aquisição. */
export async function enviarEmailAquisicao(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  idempotencyKey?: string;
  acquisitionContactBasis?: string;
  headers?: Record<string, string>;
}): Promise<SendEmailResult> {
  return enviarEmail({ ...opts, purpose: 'acquisition', acquisitionContactBasis: opts.acquisitionContactBasis });
}

/** Diagnóstico seguro (sem senha). */
export function smtpPublicStatus() {
  return {
    configured: mailConfigured(),
    resend: resendConfigured(),
    smtp: smtpConfigured(),
    host: cleanEnv(process.env.SMTP_HOST) || null,
    port: Number(cleanEnv(process.env.SMTP_PORT) || '587'),
    user_set: Boolean(cleanEnv(process.env.SMTP_USER)),
    pass_set: Boolean(smtpPass()),
    from: defaultFrom(),
  };
}
