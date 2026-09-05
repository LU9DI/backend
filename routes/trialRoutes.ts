import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { validateBody, schemaTrialAtivar } from '../middleware/validate.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  ativarTrial,
  TrialConflictError,
  TrialValidationError,
} from '../services/trialService.js';

const trialLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Limite de ativações excedido.' },
});

export function mountTrialRoutes(app: Express) {
  app.post(
    '/api/trial/ativar',
    trialLimiter,
    validateBody(schemaTrialAtivar),
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const result = await ativarTrial({
          cnpj: String(req.body.cnpj),
          nome_empresa: String(req.body.nome_empresa),
          email: String(req.body.email),
          senha: String(req.body.senha),
          google_review_url: req.body.google_review_url
            ? String(req.body.google_review_url)
            : undefined,
        });
        res.status(201).json(result);
      } catch (e: any) {
        if (e instanceof TrialConflictError || e instanceof TrialValidationError) {
          return res.status(e.status).json({ error: e.message });
        }
        if (e?.status) return res.status(e.status).json({ error: e.message });
        throw e;
      }
    })
  );
}
