/**
 * Reset em massa de contas trial/teste (somente admin).
 */
import type { Express, Response } from 'express';
import { getDb } from '../lib/db.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

function requireAdmin(req: AuthRequest, res: Response): boolean {
  if (!isAdminUser(req.user)) {
    res.status(403).json({ error: 'Acesso negado.' });
    return false;
  }
  return true;
}

async function purgeEmpresa(db: any, id: string) {
  const tables = [
    'reviews',
    'ai_usage',
    'push_subscriptions',
    'unidades',
    'webauthn_credentials',
  ];
  for (const t of tables) {
    try {
      await db.run(`DELETE FROM ${t} WHERE empresa_id = ?`, [id]);
    } catch {
      /* tabela pode não existir */
    }
  }
  try {
    await db.run(
      `DELETE FROM usuarios WHERE empresa_id = ? AND COALESCE(empresa_id,'') != 'admin'`,
      [id]
    );
  } catch {
    /* */
  }
  await db.run(`DELETE FROM empresas WHERE id = ?`, [id]);
}

export function mountAdminResetTestRoutes(app: Express) {
  app.post(
    '/api/admin/empresas/reset-testes',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;

      const confirm = String(req.body?.confirm || '').trim();
      if (confirm !== 'RESET_TESTES') {
        return res.status(400).json({
          error: 'Confirme com body: { "confirm": "RESET_TESTES" }',
        });
      }

      const db = getDb();
      const rows = await db.all(
        `SELECT id, nome_empresa, cnpj, slug, plan, status
         FROM empresas
         WHERE LOWER(COALESCE(plan,'')) IN ('trial','teste','test')
            OR LOWER(COALESCE(status,'')) IN ('trial','teste','test')
         ORDER BY criado_em DESC
         LIMIT 1000`
      );

      const removidas: { id: string; nome_empresa: string; plan: string; status: string }[] = [];
      for (const e of rows || []) {
        await purgeEmpresa(db, e.id);
        removidas.push({
          id: e.id,
          nome_empresa: e.nome_empresa,
          plan: e.plan,
          status: e.status,
        });
      }

      res.json({
        success: true,
        total: removidas.length,
        removidas,
        mensagem:
          removidas.length === 0
            ? 'Nenhuma conta trial/teste encontrada.'
            : `${removidas.length} conta(s) de teste removida(s) com reviews e usuários ligados.`,
      });
    })
  );

  /** Lista o que seria removido sem apagar */
  app.get(
    '/api/admin/empresas/reset-testes/preview',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;
      const db = getDb();
      const rows = await db.all(
        `SELECT id, nome_empresa, cnpj, slug, plan, status, criado_em, expira_em
         FROM empresas
         WHERE LOWER(COALESCE(plan,'')) IN ('trial','teste','test')
            OR LOWER(COALESCE(status,'')) IN ('trial','teste','test')
         ORDER BY criado_em DESC
         LIMIT 1000`
      );
      res.json({ total: rows?.length || 0, empresas: rows || [] });
    })
  );
}
