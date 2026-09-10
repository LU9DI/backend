/**
 * Recuperação de senha do ADMIN (painel /admin).
 * Exige ADMIN_RECOVERY_SECRET + e-mail do admin.
 */
import type { Express, Request, Response } from 'express';
import type { Database } from 'sqlite';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { enviarEmail, smtpConfigured } from './lib/mailer.js';
import {
  ensureAuthColumns,
  invalidatePasswordResetTokens,
} from './passwordResetRoutes.js';

const APP_URL = (process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(
  /\/$/,
  ''
);

function adminEmail(): string {
  return (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
}

function recoverySecret(): string {
  return String(process.env.ADMIN_RECOVERY_SECRET || '').trim();
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

const adminForgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Muitas tentativas de recuperação do admin. Aguarde 1 hora.' },
});

const adminResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  message: { error: 'Muitas tentativas. Aguarde um pouco.' },
});

export function isAdminUsuario(usuario: any): boolean {
  if (!usuario) return false;
  const email = String(usuario.email || '').toLowerCase();
  const adm = adminEmail();
  return usuario.empresa_id === 'admin' || (adm !== '' && email === adm);
}

export function mountAdminPasswordResetRoutes(app: Express, getDb: () => Database) {
  app.post('/api/admin/forgot-password', adminForgotLimiter, async (req: Request, res: Response) => {
    try {
      const secretCfg = recoverySecret();
      if (!secretCfg || secretCfg.length < 12) {
        console.error('ADMIN_RECOVERY_SECRET não configurada ou muito curta (mín. 12).');
        return res.status(503).json({
          error:
            'Recuperação do admin desativada. Configure ADMIN_RECOVERY_SECRET no Render (mín. 12 caracteres).',
        });
      }

      if (!adminEmail()) {
        return res.status(503).json({
          error: 'ADMIN_EMAIL não configurado no servidor.',
        });
      }

      const email = String(req.body.email || '')
        .trim()
        .toLowerCase();
      const recoverySecretBody = String(req.body.recovery_secret || req.body.chave || '').trim();

      const okMsg =
        'Se os dados estiverem corretos, um link de redefinição será enviado ao e-mail do administrador.';

      if (!email || !recoverySecretBody) {
        return res.status(400).json({
          error: 'Informe o e-mail do admin e a chave de recuperação (ADMIN_RECOVERY_SECRET).',
        });
      }

      if (!timingSafeEqualStr(recoverySecretBody, secretCfg)) {
        await new Promise((r) => setTimeout(r, 400 + Math.random() * 400));
        return res.status(401).json({ error: 'Dados inválidos.' });
      }

      if (email !== adminEmail()) {
        await new Promise((r) => setTimeout(r, 300));
        return res.json({ success: true, message: okMsg });
      }

      const db = getDb();
      await ensureAuthColumns(db);
      const usuario = await db.get('SELECT * FROM usuarios WHERE email = ?', [email]);

      if (!usuario || !isAdminUsuario(usuario) || !usuario.email) {
        console.warn('[admin-recovery] usuário admin não encontrado no banco para', email);
        return res.json({ success: true, message: okMsg });
      }

      await invalidatePasswordResetTokens(db, usuario.id);

      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expira = new Date(Date.now() + 30 * 60 * 1000).toISOString();

      await db.run(
        `INSERT INTO password_resets (id, usuario_id, token_hash, expira_em, usado)
         VALUES (?, ?, ?, ?, 0)`,
        [crypto.randomUUID(), usuario.id, tokenHash, expira]
      );

      const link = `${APP_URL}/admin/login?token=${token}`;
      const sent = await enviarEmail({
        to: usuario.email,
        subject: 'Filtra.IA — redefinição de senha do ADMIN',
        text: [
          'Olá,',
          '',
          'Foi solicitada a redefinição da senha do painel administrativo Filtra.IA.',
          'Se foi você, use o link abaixo (válido por 30 minutos, uso único):',
          '',
          link,
          '',
          'Links anteriores de recuperação foram invalidados.',
          'Se não foi você, altere a ADMIN_RECOVERY_SECRET no servidor e ignore este e-mail.',
          '',
          '— Filtra.IA (segurança)',
        ].join('\n'),
      });

      console.log(
        `[admin-recovery] smtp=${smtpConfigured()} sent=${sent.ok} mode=${sent.mode} err=${sent.error || '-'}`
      );

      if (!sent.ok) {
        return res.status(503).json({
          error:
            'Não foi possível enviar o e-mail. Verifique SMTP_HOST/USER/PASS/FROM no Render e os logs (Falha SMTP).',
          smtp: smtpConfigured(),
          detail: process.env.NODE_ENV === 'production' ? undefined : sent.error,
        });
      }

      return res.json({
        success: true,
        message: okMsg,
        smtp: true,
        delivered: true,
      });
    } catch (e: any) {
      console.error('admin forgot-password:', e.message || e);
      return res.status(500).json({ error: 'Erro ao processar a solicitação.' });
    }
  });

  app.post('/api/admin/reset-password', adminResetLimiter, async (req: Request, res: Response) => {
    try {
      const token = String(req.body.token || '').trim();
      const nova = String(req.body.nova_senha || req.body.senha || '');

      if (!token || token.length < 20) {
        return res.status(400).json({ error: 'Token inválido.' });
      }
      if (nova.length < 10) {
        return res.status(400).json({ error: 'A nova senha deve ter pelo menos 10 caracteres.' });
      }
      if (!/\d/.test(nova)) {
        return res.status(400).json({ error: 'A nova senha deve conter pelo menos um número.' });
      }
      if (!/[A-Za-z]/.test(nova)) {
        return res.status(400).json({ error: 'A nova senha deve conter letras.' });
      }

      const db = getDb();
      await ensureAuthColumns(db);

      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const row = await db.get(
        `SELECT * FROM password_resets
         WHERE token_hash = ? AND usado = 0
         ORDER BY criado_em DESC LIMIT 1`,
        [tokenHash]
      );

      if (!row) {
        return res.status(400).json({ error: 'Link inválido ou já utilizado.' });
      }
      if (new Date(row.expira_em).getTime() < Date.now()) {
        await db.run('UPDATE password_resets SET usado = 1 WHERE id = ?', [row.id]);
        return res.status(400).json({ error: 'Link expirado. Solicite uma nova recuperação.' });
      }

      const usuario = await db.get('SELECT * FROM usuarios WHERE id = ?', [row.usuario_id]);
      if (!usuario || !isAdminUsuario(usuario)) {
        return res.status(403).json({ error: 'Token não autorizado para o painel admin.' });
      }

      const hash = await bcrypt.hash(nova, 12);
      await db.run('UPDATE usuarios SET senha_hash = ? WHERE id = ?', [hash, row.usuario_id]);

      await db.run('UPDATE password_resets SET usado = 1 WHERE id = ?', [row.id]);
      await invalidatePasswordResetTokens(db, row.usuario_id);

      return res.json({
        success: true,
        message: 'Senha do admin atualizada. Entre em /admin/login.',
      });
    } catch (e: any) {
      console.error('admin reset-password:', e.message || e);
      return res.status(500).json({ error: 'Erro ao processar a solicitação.' });
    }
  });
}
