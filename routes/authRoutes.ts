import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { clearAuthCookie, extrairToken, verifyAccessToken } from '../lib/auth.js';
import { validateBody, schemaLoginEmpresa } from '../middleware/validate.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { loginEmpresa, AuthUnauthorizedError } from '../services/authService.js';
import { getDb } from '../lib/db.js';
import { writeAuditFromReq } from '../lib/auditLog.js';

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
      const email = req.body.email ? String(req.body.email) : undefined;
      const cnpj = req.body.cnpj ? String(req.body.cnpj) : undefined;
      const tax_id = req.body.tax_id ? String(req.body.tax_id) : undefined;
      const senha = String(req.body.senha || '');

      if (!email && !cnpj && !tax_id) {
        return res.status(400).json({
          error: 'Informe e-mail ou identificação fiscal (CNPJ / Tax ID).',
        });
      }

      try {
        const result = await loginEmpresa(
          { email, cnpj, tax_id, senha },
          res,
          getDb(),
          req
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

  app.post(
    '/api/auth/logout',
    asyncHandler(async (req: Request, res: Response) => {
      let actor: { id?: string; empresa_id?: string } = {};
      try {
        const token = extrairToken(req);
        if (token) {
          const p = verifyAccessToken(token);
          actor = { id: p.id, empresa_id: p.empresa_id };
        }
      } catch {
        /* token inválido — logout mesmo assim */
      }
      try {
        await writeAuditFromReq(getDb(), req, {
          action: 'auth.logout',
          actor_user_id: actor.id,
          empresa_id: actor.empresa_id,
          actor_role: actor.empresa_id === 'admin' ? 'admin' : 'empresa',
          result: 'ok',
        });
      } catch {
        /* */
      }
      clearAuthCookie(res);
      res.json({ success: true });
    })
  );
}
