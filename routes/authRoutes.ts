import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { clearAuthCookie } from '../lib/auth.js';
import { validateBody, schemaLoginEmpresa } from '../middleware/validate.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { loginEmpresa, AuthUnauthorizedError } from '../services/authService.js';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Muitas tentativas de login.' },
});

export function mountAuthRoutes(app: Express) {
  app.post(
    '/api/auth/login',
    loginLimiter,
    validateBody(schemaLoginEmpresa),
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const result = await loginEmpresa(
          { cnpj: String(req.body.cnpj), senha: String(req.body.senha) },
          res
        );
        res.json(result);
      } catch (e: any) {
        if (e instanceof AuthUnauthorizedError) {
          return res.status(401).json({ error: e.message });
        }
        if (e?.status) return res.status(e.status).json({ error: e.message });
        throw e;
      }
    })
  );

  app.post('/api/auth/logout', (_req, res) => {
    clearAuthCookie(res);
    res.json({ success: true });
  });
}
