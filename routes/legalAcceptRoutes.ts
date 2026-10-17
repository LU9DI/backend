/**
 * Registro de aceite dos Termos / Política de Privacidade.
 * Público (trial e checkout) — grava em audit_logs.
 */
import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from '../lib/db.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { writeAuditFromReq } from '../lib/auditLog.js';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitos registros de aceite. Aguarde.' },
});

const TERMOS_VERSAO = '2026-09-15';
const PRIVACIDADE_VERSAO = '2026-09-15';

export function mountLegalAcceptRoutes(app: Express) {
  app.post(
    '/api/legal/aceite',
    limiter,
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body || {};
      if (!body.aceito) {
        return res.status(400).json({ error: 'Aceite obrigatório.' });
      }

      const plano = body.plano ? String(body.plano).slice(0, 80) : null;
      const preco = body.preco_exibido != null ? String(body.preco_exibido).slice(0, 40) : null;
      const ciclo = body.ciclo ? String(body.ciclo).slice(0, 20) : null;
      const email = body.email ? String(body.email).toLowerCase().slice(0, 120) : null;
      const empresaId = body.empresa_id ? String(body.empresa_id).slice(0, 80) : null;
      const contexto = body.contexto === 'trial' ? 'trial' : 'checkout';
      const versaoTermos = String(body.versao_termos || TERMOS_VERSAO).slice(0, 32);
      const versaoPriv = String(body.versao_privacidade || PRIVACIDADE_VERSAO).slice(0, 32);

      const db = getDb();
      await writeAuditFromReq(db, req, {
        action: contexto === 'trial' ? 'legal.aceite_trial' : 'legal.aceite_checkout',
        actor_user_id: email,
        empresa_id: empresaId,
        target: plano || contexto,
        result: 'ok',
        detail: {
          email,
          plano,
          preco_exibido: preco,
          ciclo,
          contexto,
          versao_termos: versaoTermos,
          versao_privacidade: versaoPriv,
          metodo: body.metodo ? String(body.metodo).slice(0, 20) : null,
        },
      });

      res.json({
        ok: true,
        registrado_em: new Date().toISOString(),
        versao_termos: versaoTermos,
        versao_privacidade: versaoPriv,
      });
    })
  );
}
