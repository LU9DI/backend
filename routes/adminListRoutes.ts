import type { Express, Response } from 'express';
import { getDb } from '../lib/db.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';

export function mountAdminListRoutes(app: Express) {
  app.get('/api/admin/empresas', autenticarToken, async (req: AuthRequest, res: Response) => {
    if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Acesso negado.' });
    const rows = await getDb().all('SELECT * FROM empresas ORDER BY criado_em DESC LIMIT 200');
    res.json(rows);
  });

  app.get('/api/admin/reviews', autenticarToken, async (req: AuthRequest, res: Response) => {
    if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Acesso negado.' });
    const rows = await getDb().all('SELECT * FROM reviews ORDER BY createdAt DESC LIMIT 100');
    res.json(rows);
  });
}
