/**
 * Reset de empresas de teste (somente admin).
 * - DELETE trials em massa
 * - Manter apenas uma empresa pelo nome (ex.: "empresa 3")
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

function nomeMatch(nome: string, keep: string): boolean {
  const a = String(nome || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const b = String(keep || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!b) return false;
  return a === b || a.includes(b) || b.includes(a);
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
  app.get(
    '/api/admin/empresas/reset-testes/preview',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;
      const db = getDb();
      const keep = String(req.query.keep || req.query.manter || '').trim();
      const all = await db.all(
        `SELECT id, nome_empresa, cnpj, slug, plan, status, criado_em, expira_em
         FROM empresas
         ORDER BY criado_em DESC
         LIMIT 2000`
      );
      const manter = keep
        ? (all || []).filter(
            (e: any) => nomeMatch(e.nome_empresa, keep) || nomeMatch(e.slug || '', keep)
          )
        : [];
      const remover = keep
        ? (all || []).filter(
            (e: any) =>
              !nomeMatch(e.nome_empresa, keep) && !nomeMatch(e.slug || '', keep)
          )
        : (all || []).filter(
            (e: any) =>
              ['trial', 'teste', 'test'].includes(String(e.plan || '').toLowerCase()) ||
              ['trial', 'teste', 'test'].includes(String(e.status || '').toLowerCase())
          );
      res.json({
        total_empresas: all?.length || 0,
        keep_query: keep || null,
        manter,
        remover,
        total_remover: remover.length,
      });
    })
  );

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
      const keepName = String(req.body?.keep || req.body?.manter || '').trim();
      const rows = await db.all(
        `SELECT id, nome_empresa, cnpj, slug, plan, status
         FROM empresas
         WHERE LOWER(COALESCE(plan,'')) IN ('trial','teste','test')
            OR LOWER(COALESCE(status,'')) IN ('trial','teste','test')
         ORDER BY criado_em DESC
         LIMIT 1000`
      );
      const removidas: any[] = [];
      for (const e of rows || []) {
        if (
          keepName &&
          (nomeMatch(e.nome_empresa, keepName) || nomeMatch(e.slug || '', keepName))
        ) {
          continue;
        }
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
        mantida: keepName || null,
        removidas,
        mensagem:
          removidas.length === 0
            ? 'Nenhuma conta trial/teste removida.'
            : `${removidas.length} conta(s) removida(s).`,
      });
    })
  );

  /** Remove TODAS as empresas exceto a(s) que batem com o nome. */
  app.post(
    '/api/admin/empresas/manter-apenas',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;
      const confirm = String(req.body?.confirm || '').trim();
      const nome = String(req.body?.nome || req.body?.keep || req.body?.manter || '').trim();
      if (confirm !== 'MANTER_APENAS' || !nome) {
        return res.status(400).json({
          error: 'Body: { "confirm": "MANTER_APENAS", "nome": "empresa 3" }',
        });
      }

      const db = getDb();
      const all = await db.all(
        `SELECT id, nome_empresa, cnpj, slug, plan, status FROM empresas ORDER BY criado_em DESC LIMIT 2000`
      );
      const manter = (all || []).filter(
        (e: any) => nomeMatch(e.nome_empresa, nome) || nomeMatch(e.slug || '', nome)
      );
      if (!manter.length) {
        return res.status(404).json({
          error: `Nenhuma empresa encontrada com nome parecido com "${nome}". Nada foi apagado.`,
        });
      }

      const removidas: any[] = [];
      for (const e of all || []) {
        if (nomeMatch(e.nome_empresa, nome) || nomeMatch(e.slug || '', nome)) continue;
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
        mantidas: manter.map((e: any) => ({
          id: e.id,
          nome_empresa: e.nome_empresa,
          slug: e.slug,
          plan: e.plan,
        })),
        total_removidas: removidas.length,
        removidas,
        mensagem: `Mantida(s) ${manter.length}; removidas ${removidas.length}.`,
      });
    })
  );
}
