/**
 * Rotas WeChat Pay — OFF até configurar env (mesmo padrão Stripe).
 */
import type { Express, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { wechatConfigured, wechatStatus, createWechatOrder } from '../lib/wechat.js';
import { resolvePlano } from '../stripeBilling.js';
import { getDb } from '../lib/db.js';

export function mountWechatRoutes(app: Express) {
  app.get('/api/wechat/status', (_req, res) => {
    res.json(wechatStatus());
  });

  app.post(
    '/api/wechat/create-order',
    asyncHandler(async (req: Request, res: Response) => {
      if (!wechatConfigured()) {
        return res.status(503).json({
          error:
            'WeChat Pay OFF. Defina WECHAT_APP_ID, WECHAT_MCH_ID e WECHAT_API_KEY no Render quando for usar na China.',
          configured: false,
          provider: 'wechat_pay',
        });
      }

      const plano = String(req.body?.plano || '').trim();
      if (!resolvePlano(plano)) {
        return res.status(400).json({ error: 'Plano inválido.' });
      }

      const empresaId = req.body?.empresa_id ? String(req.body.empresa_id) : null;
      if (empresaId) {
        const emp = await getDb().get(`SELECT id FROM empresas WHERE id = ?`, [empresaId]);
        if (!emp) return res.status(404).json({ error: 'Empresa não encontrada.' });
      }

      try {
        const order = await createWechatOrder({
          planoKey: plano,
          empresaId,
          email: req.body?.email ? String(req.body.email) : null,
          openid: req.body?.openid ? String(req.body.openid) : null,
        });
        return res.json({
          success: true,
          provider: 'wechat_pay',
          ...order,
        });
      } catch (e: any) {
        const msg = e?.message || 'WeChat error';
        // 503 se ainda for “não ligado de verdade”
        if (String(msg).includes('ainda não está ligada')) {
          return res.status(503).json({ error: msg, configured: true, incomplete: true });
        }
        return res.status(502).json({ error: msg });
      }
    })
  );

  /** Webhook / notify — placeholder (sempre 200 para não re-tentar infinito se alguém apontar URL). */
  app.post(
    '/api/webhook/wechat',
    asyncHandler(async (req: Request, res: Response) => {
      if (!wechatConfigured()) {
        return res.status(503).json({ code: 'FAIL', message: 'WeChat OFF' });
      }
      // TODO: validar assinatura WeChat Pay v3 e ativar plano
      console.log('[wechat webhook] recebido (stub)', JSON.stringify(req.body || {}).slice(0, 200));
      res.json({ code: 'SUCCESS', message: 'OK' });
    })
  );
}
