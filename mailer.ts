/**
 * Envio de e-mail via SMTP (nodemailer opcional) ou log em desenvolvimento.
 *
 * Env:
 *   SMTP_HOST=
 *   SMTP_PORT=587
 *   SMTP_USER=
 *   SMTP_PASS=
 *   SMTP_FROM="Filtra.IA <noreply@seudominio.com>"
 */

export function smtpConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

export async function enviarEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<{ ok: boolean; mode: 'smtp' | 'console' }> {
  const from = process.env.SMTP_FROM || 'noreply@localhost';

  if (!smtpConfigured()) {
    console.log('────────────────────────────────────────────');
    console.log('📧 [dev] E-mail não enviado (SMTP ausente). Conteúdo:');
    console.log('Para:', opts.to);
    console.log('Assunto:', opts.subject);
    console.log(opts.text);
    console.log('────────────────────────────────────────────');
    return { ok: true, mode: 'console' };
  }

  try {
    // Import dinâmico — se nodemailer não estiver instalado, cai no console
    const nodemailer = await import('nodemailer');
    const port = Number(process.env.SMTP_PORT || 587);
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth:
        process.env.SMTP_USER && process.env.SMTP_PASS
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
    });

    await transporter.sendMail({
      from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html || opts.text.replace(/\n/g, '<br/>'),
    });
    return { ok: true, mode: 'smtp' };
  } catch (e: any) {
    console.error('Falha SMTP:', e.message || e);
    console.log('────────────────────────────────────────────');
    console.log('📧 Fallback console — link de recuperação:');
    console.log(opts.text);
    console.log('────────────────────────────────────────────');
    return { ok: true, mode: 'console' };
  }
}

