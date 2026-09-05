import type { Express, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from '../lib/db.js';
import { autenticarToken, type AuthRequest } from '../lib/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  ensurePushSchema,
  getVapidPublicKey,
  initWebPush,
  pushConfigured,
  saveSubscription,
  removeSubscription,
  sendPushToEmpresa,
} from '../lib/push.js';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: 'Muitas requisições de push.' },
});

export function mountPushRoutes(app: Express) {
  app.get('/api/push/vapid-public-key', (_req, res) => {
    const key = getVapidPublicKey();
    if (!key) {
      return res.status(503).json({
        error: 'Push não configurado. Defina VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY.',
        configured: false,
      });
    }
    res.json({ publicKey: key, configured: true });
  });

  app.post(
    '/api/push/subscribe',
    limiter,
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!pushConfigured()) {
        return res.status(503).json({ error: 'Push não configurado no servidor.' });
      }
      const db = getDb();
      await ensurePushSchema(db);
      const sub = req.body?.subscription || req.body;
      const endpoint = sub?.endpoint;
      const keys = sub?.keys;
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return res.status(400).json({ error: 'subscription inválida.' });
      }
      const id = await saveSubscription(db, {
        endpoint: String(endpoint),
        keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) },
        userId: req.user?.id,
        empresaId: req.user?.empresa_id,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
      });
      res.json({ success: true, id });
    })
  );

  app.post(
    '/api/push/unsubscribe',
    limiter,
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const endpoint = String(req.body?.endpoint || '');
      if (!endpoint) return res.status(400).json({ error: 'endpoint obrigatório.' });
      const db = getDb();
      await ensurePushSchema(db);
      await removeSubscription(db, endpoint);
      res.json({ success: true });
    })
  );

  /** Teste manual (usuário autenticado → push na própria empresa). */
  app.post(
    '/api/push/test',
    limiter,
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!initWebPush()) {
        return res.status(503).json({ error: 'Push não configurado.' });
      }
      const db = getDb();
      await ensurePushSchema(db);
      const empresaId = req.user?.empresa_id;
      if (!empresaId) return res.status(400).json({ error: 'Sem empresa.' });
      const result = await sendPushToEmpresa(db, empresaId, {
        title: 'Filtra.IA',
        body: 'Notificação de teste — push OK.',
        url: empresaId === 'admin' ? '/admin' : `/painel/${empresaId}`,
        tag: 'test',
      });
      res.json({ success: true, ...result });
    })
  );
}
