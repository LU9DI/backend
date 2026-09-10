/**
 * Envio de e-mail via SMTP (nodemailer).
 *
 * Env obrigatórias para envio real:
 *   SMTP_HOST=smtp.gmail.com | smtp.office365.com | ...
 *   SMTP_PORT=587 (ou 465)
 *   SMTP_USER=...
 *   SMTP_PASS=...   (Gmail: senha de app, não a senha normal)
 *   SMTP_FROM="Filtra.IA <seu@dominio.com>"  (ideal: mesmo domínio do USER)
 */

export function smtpConfigured(): boolean {
  return !!(
    process.env.SMTP_HOST?.trim() &&
    process.env.SMTP_FROM?.trim() &&
    process.env.SMTP_USER?.trim() &&
    process.env.SMTP_PASS?.trim()
  );
}

export type SendEmailResult = {
  ok: boolean;
  mode: 'smtp' | 'console' | 'error';
  messageId?: string;
  error?: string;
};

function buildTransport() {
  const port = Number(process.env.SMTP_PORT || 587);
  const host = process.env.SMTP_HOST!.trim();
  const secure = port === 465 || process.env.SMTP_SECURE === '1';

  return {
    host,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER!.trim(),
      pass: process.env.SMTP_PASS!.trim(),
    },
    // evita falha em alguns provedores com cert intermediário
    tls: {
      rejectUnauthorized: process.env.SMTP_TLS_REJECT === '1',
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  };
}

export async function enviarEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<SendEmailResult> {
  const from = process.env.SMTP_FROM?.trim() || 'noreply@localhost';
  const to = String(opts.to || '').trim().toLowerCase();

  if (!to || !to.includes('@')) {
    console.error('[mail] destinatário inválido');
    return { ok: false, mode: 'error', error: 'destinatário inválido' };
  }

  if (!smtpConfigured()) {
    console.warn('[mail] SMTP incompleto — defina SMTP_HOST, SMTP_FROM, SMTP_USER, SMTP_PASS');
    console.log('────────────────────────────────────────────');
    console.log('📧 [dev/fallback] E-mail NÃO enviado. Conteúdo:');
    console.log('Para:', to);
    console.log('Assunto:', opts.subject);
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
      // melhora deliverability básica
      headers: {
        'X-Mailer': 'Filtra.IA',
      },
    });

    const messageId = info?.messageId ? String(info.messageId) : undefined;
    console.log(`[mail] OK to=${to.replace(/(.{2}).+(@.+)/, '$1***$2')} id=${messageId || '?'}`);
    return { ok: true, mode: 'smtp', messageId };
  } catch (e: any) {
    const msg = String(e?.message || e);
    console.error('[mail] FALHA SMTP:', msg);
    // dicas comuns
    if (/Invalid login|Authentication|535|534/i.test(msg)) {
      console.error(
        '[mail] Dica: usuário/senha rejeitados. Gmail precisa de Senha de app (2FA). Outlook: SMTP AUTH habilitado.'
      );
    }
    if (/self-signed|certificate/i.test(msg)) {
      console.error('[mail] Dica: tente SMTP_PORT=587 ou SMTP_TLS_REJECT=0');
    }
    return { ok: false, mode: 'error', error: msg.slice(0, 200) };
  }
}
