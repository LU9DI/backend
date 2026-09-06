/**
 * Export CSV de críticas (1–3★) do painel do cliente.
 */
import type { Express, Response } from 'express';
import { getDb, findEmpresa } from '../lib/db.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

function podeGerir(req: AuthRequest, empresaId: string): boolean {
  if (isAdminUser(req.user)) return true;
  return Boolean(req.user?.empresa_id && req.user.empresa_id === empresaId);
}

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function mountExportRoutes(app: Express) {
  app.get(
    '/api/empresa/:ref/criticas.csv',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const emp = await findEmpresa(String(req.params.ref));
      if (!emp) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerir(req, emp.id)) return res.status(403).json({ error: 'Sem permissão.' });

      const rows = await getDb().all(
        `SELECT id, name, rating, comment, ai_reply, client_whatsapp, createdAt, treated_at
         FROM reviews
         WHERE empresa_id = ? AND rating <= 3 AND IFNULL(is_test,0) = 0
         ORDER BY createdAt DESC
         LIMIT 2000`,
        [emp.id]
      );

      const header = [
        'id',
        'nome',
        'nota',
        'comentario',
        'resposta_ia',
        'whatsapp_cliente',
        'criado_em',
        'tratada_em',
      ];
      const lines = [header.join(',')];
      for (const r of rows || []) {
        lines.push(
          [
            r.id,
            r.name,
            r.rating,
            r.comment,
            r.ai_reply,
            r.client_whatsapp,
            r.createdAt,
            r.treated_at,
          ]
            .map(csvEscape)
            .join(',')
        );
      }

      const body = lines.join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="criticas-${emp.slug || emp.id}.csv"`
      );
      res.send('\uFEFF' + body);
    })
  );
}
