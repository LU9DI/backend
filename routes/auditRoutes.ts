/**
 * Consulta de logs de auditoria (admin).
 */
import type { Express, Response } from 'express';
import { getDb } from '../lib/db.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ensureAuditSchema, listAuditLogs } from '../lib/auditLog.js';

export function mountAuditRoutes(app: Express) {
  app.get(
    '/api/admin/audit-logs',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!isAdminUser(req.user)) {
        return res.status(403).json({ error: 'Acesso negado.' });
      }
      const db = getDb();
      await ensureAuditSchema(db);
      const items = await listAuditLogs(db, {
        limit: Number(req.query.limit) || 80,
        empresa_id: req.query.empresa_id ? String(req.query.empresa_id) : undefined,
        action: req.query.action ? String(req.query.action) : undefined,
      });
      res.json({
        total: (items || []).length,
        items: items || [],
        gerado_em: new Date().toISOString(),
      });
    })
  );
}
