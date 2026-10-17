/**
 * Captação consentida (POST /api/lead).
 *
 * Contrato usado pelo frontend: exige consentimento explícito e cria o trial
 * imediatamente. O registro comercial em `leads` (fonte='trial') já é criado e
 * qualificado por `ativarTrial`; aqui só acrescentamos a prova do consentimento
 * em `raw_json`, sem alterar o esquema da tabela `leads` usada pelo motor de aquisição.
 */
import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { validateBody, type Schema } from '../middleware/validate.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { clientIp } from '../lib/reviewFraud.js';
import { getDb } from '../lib/db.js';
import { ativarTrial, TrialConflictError, TrialValidationError } from '../services/trialService.js';

export const schemaLead: Schema = {
  nome_empresa: { required: true, type: 'string', min: 2, max: 120, message: 'Nome da empresa inválido.' },
  email: { required: true, type: 'email' },
  senha: { required: true, type: 'password_empresa' },
  google_review_url: { required: false, type: 'url', max: 500 },
  whatsapp: { required: false, type: 'string', max: 20 },
  locale: { required: false, type: 'string', max: 8 },
  consent: { required: true, type: 'boolean', message: 'Consentimento explícito é necessário.' },
  source: { required: false, type: 'string', max: 120 },
};

const leadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite de captações excedido. Tente novamente mais tarde.' },
});

/** Acrescenta a prova de consentimento ao lead criado pelo trial. Best-effort: nunca derruba a resposta. */
export async function recordLeadConsent(email: string, source: string): Promise<void> {
  try {
    const db = getDb();
    const row = await db.get(
      `SELECT id, raw_json FROM leads WHERE lower(email) = lower(?) AND fonte = 'trial' LIMIT 1`,
      [email]
    );
    if (!row) return;
    let raw: Record<string, unknown> = {};
    try { raw = JSON.parse(String(row.raw_json || '{}')) || {}; } catch { raw = {}; }
    raw.consent = true;
    raw.consent_at = new Date().toISOString();
    raw.source = source;
    await db.run(`UPDATE leads SET raw_json = ? WHERE id = ?`, [JSON.stringify(raw).slice(0, 4000), row.id]);
  } catch (e: any) {
    console.warn('[lead] consent record:', e?.message || e);
  }
}

export function mountLeadRoutes(app: Express) {
  app.post(
    '/api/lead',
    leadLimiter,
    validateBody(schemaLead),
    asyncHandler(async (req: Request, res: Response) => {
      if (req.body.consent !== true) {
        return res.status(400).json({ error: 'Consentimento explícito é necessário.' });
      }
      const email = String(req.body.email).trim().toLowerCase();
      const source = req.body.source ? String(req.body.source).slice(0, 120) : 'website';
      try {
        const result = await ativarTrial(
          {
            nome_empresa: String(req.body.nome_empresa),
            email,
            senha: String(req.body.senha),
            google_review_url: req.body.google_review_url ? String(req.body.google_review_url) : undefined,
            whatsapp: req.body.whatsapp ? String(req.body.whatsapp) : undefined,
            locale: req.body.locale ? String(req.body.locale) : undefined,
            ip: clientIp(req as any),
          },
          undefined,
          res
        );
        await recordLeadConsent(email, source);
        return res.status(201).json({ ...result, lead_captured: true });
      } catch (e: any) {
        if (e instanceof TrialConflictError || e?.name === 'TrialConflictError') {
          return res.status(409).json({ error: e.message || 'Este e-mail ou IP já utilizou o período de testes.' });
        }
        if (e instanceof TrialValidationError || e?.name === 'TrialValidationError') {
          return res.status(400).json({ error: e.message });
        }
        console.error('[lead]', e?.code, e?.message || e);
        return res.status(500).json({ error: 'Não foi possível processar sua inscrição.' });
      }
    })
  );
}
