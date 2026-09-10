/**
 * Diagnóstico SMTP (só admin autenticado).
 * GET  /api/admin/smtp-status
 * POST /api/admin/test-email  { "to": "opcional@email.com" }
 */
import type { Express, Response } from 'express';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { enviarEmail, smtpPublicStatus, verifySmtp } from '../lib/mailer.js';

export function mountSmtpTestRoutes(app: Express) {
  app.get(
    '/api/admin/smtp-status',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!isAdminUser(req.user)) {
        return res.status(403).json({ error: 'Acesso negado.' });
      }
      const status = smtpPublicStatus();
      const verify = status.configured ? await verifySmtp() : { ok: false, mode: 'error' as const, error: 'não configurado' };
      res.json({
        ...status,
        verify_ok: verify.ok,
        verify_error: verify.ok ? null : verify.error || null,
        dica: !status.configured
          ? 'Defina SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM no Render'
          : !verify.ok
            ? 'Credenciais rejeitadas ou host inacessível — veja verify_error e logs [mail]'
            : 'SMTP autenticou com sucesso. Pode testar envio em POST /api/admin/test-email',
      });
    })
  );

  app.post(
    '/api/admin/test-email',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!isAdminUser(req.user)) {
        return res.status(403).json({ error: 'Acesso negado.' });
      }
      const to =
        String(req.body?.to || process.env.ADMIN_EMAIL || '')
          .trim()
          .toLowerCase() || null;
      if (!to || !to.includes('@')) {
        return res.status(400).json({
          error: 'Informe { "to": "seu@email.com" } ou configure ADMIN_EMAIL.',
        });
      }

      const sent = await enviarEmail({
        to,
        subject: 'Filtra.IA — teste SMTP',
        text: [
          'Este é um e-mail de teste do Filtra.IA.',
          '',
          `Enviado em: ${new Date().toISOString()}`,
          'Se você recebeu isto, a recuperação de senha também deve funcionar com o mesmo SMTP.',
        ].join('\n'),
      });

      if (!sent.ok) {
        return res.status(503).json({
          success: false,
          error: 'Falha ao enviar. Confira SMTP no Render e logs [mail] FALHA SMTP.',
          detail: sent.error,
          smtp: smtpPublicStatus(),
        });
      }

      res.json({
        success: true,
        message: `E-mail de teste enviado para ${to}. Confira caixa de entrada e spam.`,
        messageId: sent.messageId,
      });
    })
  );
}
