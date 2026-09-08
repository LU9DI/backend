import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { clearAuthCookie, extrairToken } from '../lib/auth.js';
import { supabase } from '../lib/supabaseClient.js';
import { validateBody, schemaLoginEmpresa } from '../middleware/validate.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { loginEmpresa, AuthUnauthorizedError } from '../services/authService.js';
import { getDb } from '../lib/db.js';
import { writeAuditFromReq } from '../lib/auditLog.js';
import {
  assertNotLocked,
  recordLoginFail,
  recordLoginSuccess,
  failDelayMs,
} from '../lib/loginGuard.js';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Aguarde alguns minutos.' },
});

function clientIp(req: Request): string {
  const xf = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return xf || req.ip || 'unknown';
}

export function mountAuthRoutes(app: Express) {
  app.post(
    '/api/auth/login',
    loginLimiter,
    validateBody(schemaLoginEmpresa),
    asyncHandler(async (req: Request, res: Response) => {
      const cnpj = String(req.body.cnpj || '').replace(/\D/g, '');
      const ip = clientIp(req);
      const identity = `cnpj:${cnpj}`;

      try {
        assertNotLocked(identity, ip);
      } catch (e: any) {
        return res.status(429).json({ error: e.message || 'Bloqueado temporariamente.' });
      }

      try {
        const result = await loginEmpresa(
          { cnpj: String(req.body.cnpj), senha: String(req.body.senha) },
          res,
          getDb(),
          req
        );
        recordLoginSuccess(identity, ip);
        res.json(result);
      } catch (e: any) {
        if (e instanceof AuthUnauthorizedError || e?.status === 401) {
          recordLoginFail(identity, ip);
          const delay = failDelayMs(identity);
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          return res.status(401).json({ error: e.message || 'Credenciais inválidas.' });
        }
        if (e?.status === 429) {
          return res.status(429).json({ error: e.message });
        }
        if (e?.status) return res.status(e.status).json({ error: e.message });
        throw e;
      }
    })
  );

  app.post(
    '/api/auth/logout',
    asyncHandler(async (req: Request, res: Response) => {
      clearAuthCookie(res);
      res.json({ success: true });
    })
  );
}
