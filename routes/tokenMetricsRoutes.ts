import type { Express, Response } from 'express';
import { getDb } from '../lib/db.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getTokenMetrics } from '../lib/aiUsage.js';

export function mountTokenMetricsRoutes(app: Express) {
  app.get(
    '/api/admin/tokens/metrics',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!isAdminUser(req.user)) {
        return res.status(403).json({ error: 'Acesso negado.' });
      }
      const days = Number(req.query.days || 30);
      const metrics = await getTokenMetrics(getDb(), days);
      res.json(metrics);
    })
  );
}
