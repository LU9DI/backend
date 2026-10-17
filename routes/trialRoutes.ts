import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { validateBody, schemaTrialAtivar } from '../middleware/validate.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { clientIp } from '../lib/reviewFraud.js';
import {
  ativarTrial,
  TrialConflictError,
  TrialValidationError,
} from '../services/trialService.js';

const trialLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { error: 'Limite de ativações excedido. Tente mais tarde.' },
});

export function mountTrialRoutes(app: Express) {
  // Tombstone: o fluxo canônico ativa o trial na hora (e-mail validado por MX + controles de IP).
  // Links antigos de confirmação por e-mail não são mais emitidos; respondemos 410 explicitamente.
  app.get(
    '/api/trial/verificar',
    asyncHandler(async (_req: Request, res: Response) => {
      return res.status(410).json({
        error:
          'A confirmação por e-mail não é mais necessária. Seu teste de 7 dias é ativado na hora — acesse o painel com o e-mail e a senha cadastrados.',
        code: 'TRIAL_EMAIL_CONFIRMATION_RETIRED',
      });
    })
  );
  app.post(
    '/api/trial/ativar',
    trialLimiter,
    validateBody(schemaTrialAtivar),
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const result = await ativarTrial(
          {
            cnpj: String(req.body.cnpj),
            nome_empresa: String(req.body.nome_empresa),
            email: String(req.body.email),
            senha: String(req.body.senha),
            google_review_url: req.body.google_review_url
              ? String(req.body.google_review_url)
              : undefined,
            whatsapp: req.body.whatsapp ? String(req.body.whatsapp) : undefined,
            locale: req.body.locale ? String(req.body.locale) : undefined,
            ip: clientIp(req as any),
          },
          undefined,
          res
        );
        return res.status(201).json(result);
      } catch (e: any) {
        if (e instanceof TrialConflictError || e?.name === 'TrialConflictError') {
          return res.status(409).json({ error: e.message || 'CNPJ já cadastrado.' });
        }
        if (e instanceof TrialValidationError || e?.name === 'TrialValidationError') {
          return res.status(400).json({ error: e.message });
        }
        if (e?.status && e.status < 500) {
          return res.status(e.status).json({ error: e.message });
        }
        console.error('[trial/ativar]', e?.code, e?.message || e);
        return res.status(500).json({
          error: 'Erro ao ativar trial.',
          detail: String(e?.message || e).slice(0, 240),
        });
      }
    })
  );
}
