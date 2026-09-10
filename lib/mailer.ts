/**
 * Envio de e-mail via SMTP (nodemailer).
 *
 * Render env:
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=587
 *   SMTP_USER=seu@gmail.com
 *   SMTP_PASS=xxxx xxxx xxxx xxxx   (senha de APP do Google — sem aspas)
 *   SMTP_FROM=Filtra.IA <seu@gmail.com>
 */

function cleanEnv(v?: string | null): string {
  return String(v || '')
    .trim()
    .replace(/^['"]|['"]$/g, ''); // remove aspas acidentais do painel
}

export function smtpConfigured(): boolean {
  return !!(
    cleanEnv(process.env.SMTP_HOST) &&
    cleanEnv(process.env.SMTP_FROM) &&
    cleanEnv(process.env.SMTP_USER) &&
    cleanEnv(process.env.SMTP_PASS)
  );
}

export type SendEmailResult = {
  ok: boolean;
  mode: 'smtp' | 'console' | 'error';
  messageId?: string;
  error?: string;
};

function buildTransport() {
  const port = Number(cleanEnv(process.env.SMTP_PORT) || '587');
  const host = cleanEnv(process.env.SMTP_HOST);
  const secure = port === 465 || cleanEnv(process.env.SMTP_SECURE) === '1';
  const user = cleanEnv(process.env.SMTP_USER);
  // senha de app Gmail pode vir com espaços — nodemailer aceita; não remover espaços internos
  const pass = cleanEnv(process.env.SMTP_PASS);

  return {
    host,
    port,
    secure,
    auth: { user, pass },
    requireTLS: !secure && port === 587,
    tls: {
      // default permissivo (Render + vários SMTP); force strict com SMTP_TLS_REJECT=1
      minVersion: 'TLSv1.2' as const,
      rejectUnauthorized: cleanEnv(process.env.SMTP_TLS_REJECT) === '1',
    },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 25_000,
    logger: cleanEnv(process.env.SMTP_DEBUG) === '1',
    debug: cleanEnv(process.env.SMTP_DEBUG) === '1',
  };
}

export async function verifySmtp(): Promise<SendEmailResult> {
  if (!smtpConfigured()) {
    return { ok: false, mode: 'error', error: 'SMTP incompleto (HOST/FROM/USER/PASS)' };
  }
  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.createTransport(buildTransport());
    await transporter.verify();
    return { ok: true, mode: 'smtp' };
  } catch (e: any) {
    const msg = String(e?.message || e);
    console.error('[mail] verify falhou:', msg);
    return { ok: false, mode: 'error', error: msg.slice(0, 300) };
  }
}

export async function enviarEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<SendEmailResult> {
  const from = cleanEnv(process.env.SMTP_FROM) || 'noreply@localhost';
  const to = String(opts.to || '').trim().toLowerCase();

  if (!to || !to.includes('@')) {
    console.error('[mail] destinatário inválido');
    return { ok: false, mode: 'error', error: 'destinatário inválido' };
  }

  if (!smtpConfigured()) {
    console.warn('[mail] SMTP incompleto — defina SMTP_HOST, SMTP_FROM, SMTP_USER, SMTP_PASS');
    console.log('────────────────────────────────────────────');
    console.log('📧 E-mail NÃO enviado. Para:', to, 'Assunto:', opts.subject);
    console.log(opts.text);
    console.log('────────────────────────────────────────────');
    return { ok: false, mode: 'console', error: 'SMTP não configurado' };
  }

  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.createTransport(buildTransport());

    const info = await transporter.sendMail({
      from,
      to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html || opts.text.replace(/\n/g, '<br/>'),
      headers: { 'X-Mailer': 'Filtra.IA' },
    });

    const messageId = info?.messageId ? String(info.messageId) : undefined;
    const accepted = Array.isArray(info?.accepted) ? info.accepted.length : 0;
    const rejected = Array.isArray(info?.rejected) ? info.rejected : [];
    console.log(
      `[mail] OK to=${to.replace(/(.{2}).+(@.+)/, '$1***$2')} id=${messageId || '?'} accepted=${accepted} rejected=${JSON.stringify(rejected)}`
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
        '[mail] AUTH: Gmail → Senha de app (2FA). Outlook → SMTP AUTH. Sem aspas na SMTP_PASS no Render.'
      );
    }
    if (/self-signed|certificate/i.test(msg)) {
      console.error('[mail] TLS: use porta 587 ou SMTP_TLS_REJECT=0');
    }
    if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
      console.error('[mail] REDE: confira SMTP_HOST e SMTP_PORT (587 ou 465)');
    }
    return { ok: false, mode: 'error', error: msg.slice(0, 300) };
  }
}

/** Diagnóstico seguro (sem senha). */
export function smtpPublicStatus() {
  return {
    configured: smtpConfigured(),
    host: cleanEnv(process.env.SMTP_HOST) || null,
    port: Number(cleanEnv(process.env.SMTP_PORT) || '587'),
    user_set: Boolean(cleanEnv(process.env.SMTP_USER)),
    pass_set: Boolean(cleanEnv(process.env.SMTP_PASS)),
    from: cleanEnv(process.env.SMTP_FROM) || null,
  };
}
