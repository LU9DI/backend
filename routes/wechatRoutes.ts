/**
 * Rotas WeChat Pay — stub seguro (503 se não configurado).
 */
import type { Express, Request, Response } from 'express';
import { wechatConfigured, wechatStatus } from '../lib/wechat.js';

export function mountWechatRoutes(app: Express) {
  app.get('/api/wechat/status', (_req: Request, res: Response) => {
    res.json({
      ...wechatStatus(),
      hint: wechatConfigured()
        ? 'Credenciais presentes.'
        : 'Defina WECHAT_APP_ID, WECHAT_MCH_ID e WECHAT_API_KEY para ligar.',
    });
  });

  app.post('/api/wechat/checkout', (_req: Request, res: Response) => {
    if (!wechatConfigured()) {
      return res.status(503).json({
        error: 'WeChat Pay não configurado.',
        configured: false,
      });
    }
    return res.status(501).json({
      error: 'WeChat checkout ainda não implementado neste ambiente.',
      configured: true,
    });
  });

  app.post('/api/webhook/wechat', (_req: Request, res: Response) => {
    // Ack para não quebrar notificações futuras
    res.json({ ok: true });
  });
}
