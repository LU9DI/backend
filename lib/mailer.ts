/**
 * Envio de e-mail via Resend (preferencial), SMTP como compatibilidade
 * e log em desenvolvimento quando nenhum provedor estiver configurado.
 *
 * Resend não depende de conexão SMTP/porta de saída do Render.
 */
export function resendConfigured(): boolean {
  return !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
}

export function smtpConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

export async function enviarEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<{ ok: boolean; mode: 'resend' | 'smtp' | 'console' }> {
  const html = opts.html || opts.text.replace(/\n/g, '<br/>');

  if (resendConfigured()) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM,
          to: [opts.to],
          subject: opts.subject,
          text: opts.text,
          html,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Resend HTTP ${response.status}: ${detail.slice(0, 500)}`);
      }

      return { ok: true, mode: 'resend' };
    } catch (e: any) {
      console.error('Falha Resend:', e?.message || e);
      throw e;
    }
  }

  // Compatibilidade temporária: SMTP só é usado quando Resend não está configurado.
  if (smtpConfigured()) {
    try {
      const nodemailer = await import('nodemailer');
      const from = process.env.SMTP_FROM || 'noreply@localhost';
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
        html,
      });
      return { ok: true, mode: 'smtp' };
    } catch (e: any) {
      console.error('Falha SMTP:', e?.message || e);
      throw e;
    }
  }

  console.log('────────────────────────────────────────────');
  console.log('📧 [dev] E-mail não enviado (provedor ausente). Conteúdo:');
  console.log('Para:', opts.to);
  console.log('Assunto:', opts.subject);
  console.log(opts.text);
  console.log('────────────────────────────────────────────');
  return { ok: true, mode: 'console' };
}
