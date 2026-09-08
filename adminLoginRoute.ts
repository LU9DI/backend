/**
 * Login do painel administrativo — rate limit + lockout.
 */
import type { Express, Request, Response } from 'express';
import type { Database } from 'sqlite';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { ensureMfaColumns, issueMfaChallenge } from './mfa.js';
import { signAccessToken, verifyAccessToken } from './lib/auth.js';
import {
  assertNotLocked,
  recordLoginFail,
  recordLoginSuccess,
  failDelayMs,
} from './lib/loginGuard.js';

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Tente novamente mais tarde.' },
});

function isAdminUser(usuario: any): boolean {
  const adminMail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (usuario.empresa_id === 'admin') return true;
  if (adminMail && String(usuario.email || '').toLowerCase() === adminMail) return true;
  return false;
}

function clientIp(req: Request): string {
  const xf = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return xf || req.ip || 'unknown';
}

export function mountAdminLoginRoute(
  app: Express,
  getDb: () => Database,
  opts: {
    setAuthCookie: (res: Response, token: string) => void;
    JWT_SECRET: string;
  }
) {
  app.post('/api/admin/login', adminLoginLimiter, async (req: Request, res: Response) => {
    try {
      const email = String(req.body.email || '')
        .trim()
        .toLowerCase();
      const senha = String(req.body.senha || '');
      const ip = clientIp(req);
      const identity = `admin:${email}`;

      if (!email || !senha) {
        return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
      }

      try {
        assertNotLocked(identity, ip);
      } catch (e: any) {
        return res.status(429).json({ error: e.message || 'Bloqueado temporariamente.' });
      }

      const db = getDb();
      await ensureMfaColumns(db);
      const usuario = await db.get('SELECT * FROM usuarios WHERE email = ?', [email]);

      if (!usuario || !usuario.senha_hash || !isAdminUser(usuario)) {
        recordLoginFail(identity, ip);
        const delay = failDelayMs(identity);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        return res.status(401).json({ error: 'Credenciais inválidas.' });
      }

      const ok = await bcrypt.compare(senha, usuario.senha_hash);
      if (!ok) {
        recordLoginFail(identity, ip);
        const delay = failDelayMs(identity);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        return res.status(401).json({ error: 'Credenciais inválidas.' });
      }

      recordLoginSuccess(identity, ip);

      if (usuario.mfa_enabled) {
        const challenge = issueMfaChallenge(usuario, opts.JWT_SECRET);
        return res.json({
          success: true,
          ...challenge,
          message: 'Informe o código do autenticador.',
        });
      }

      const token = signAccessToken({
        id: usuario.id,
        nome_funcionario: usuario.nome_funcionario,
        empresa_id: usuario.empresa_id,
        role: 'admin',
      });

      opts.setAuthCookie(res, token);

      return res.json({
        success: true,
        mfa_required: false,
        token,
        tokenPayload: {
          id: usuario.id,
          nome_funcionario: usuario.nome_funcionario,
          empresa_id: usuario.empresa_id,
          role: 'admin',
        },
      });
    } catch (e) {
      console.error('Erro no admin login');
      return res.status(500).json({ error: 'Erro ao processar a solicitação.' });
    }
  });

  app.get('/api/admin/me', async (req: Request, res: Response) => {
    try {
      const raw =
        (req as any).cookies?.auth_token ||
        (req as any).cookies?.saas_auth_token ||
        (req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice(7)
          : null);

      if (!raw) {
        return res.status(401).json({ error: 'Não autenticado.' });
      }

      const decoded = verifyAccessToken(raw);
      if (decoded.role !== 'admin' && decoded.empresa_id !== 'admin') {
        return res.status(403).json({ error: 'Não é admin.' });
      }

      return res.json({
        id: decoded.id,
        role: 'admin',
        empresa_id: decoded.empresa_id,
        nome_funcionario: decoded.nome_funcionario,
      });
    } catch {
      return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    }
  });

  app.post('/api/admin/logout', (_req: Request, res: Response) => {
    res.clearCookie('auth_token', { path: '/' });
    res.clearCookie('saas_auth_token', { path: '/' });
    return res.json({ success: true });
  });
}
