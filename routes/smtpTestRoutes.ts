import type { Express } from 'express';
import { enviarEmail, smtpConfigured, resendConfigured } from '../lib/mailer.js';

/**
 * Compatibilidade para o antigo módulo de teste SMTP.
 * O endpoint só é habilitado explicitamente e exige JOBS_SECRET.
 */
export function mountSmtpTestRoutes(app: Express) {
  if (process.env.ENABLE_SMTP_TEST !== '1') return;

  app.post('/api/admin/smtp-test', async (req: any, res: any) => {
    const secret = String(process.env.JOBS_SECRET || '').trim();
    const supplied = String(req.headers['x-jobs-secret'] || '');
    if (!secret || supplied !== secret) {
      return res.status(401).json({ error: 'Não autorizado.' });
    }

    const to = String(req.body?.to || '').trim();
    if (!to || !to.includes('@')) {
      return res.status(400).json({ error: 'Destinatário inválido.' });
    }

    if (!smtpConfigured() && !resendConfigured()) {
      return res.status(503).json({ error: 'Nenhum provedor de e-mail configurado.' });
    }

    try {
      const result = await enviarEmail({
        to,
        subject: 'Teste de e-mail — Filtra.IA',
        text: 'Teste de envio de e-mail concluído com sucesso.',
      });
      return res.json({ ok: true, mode: result.mode });
    } catch (e: any) {
      return res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
    }
  });
}
