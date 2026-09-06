/**
 * CRUD simples de filiais/unidades (Corporativo, Rei, trial).
 */
import type { Express, Response } from 'express';
import { findEmpresa, getDb } from '../lib/db.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  listUnidades,
  createUnidade,
  softDeleteUnidade,
  planPermiteUnidades,
  ensureUnidadesSchema,
} from '../lib/unidades.js';

function podeGerir(req: AuthRequest, empresaId: string): boolean {
  if (isAdminUser(req.user)) return true;
  return Boolean(req.user?.empresa_id && req.user.empresa_id === empresaId);
}

export function mountUnidadeRoutes(app: Express) {
  app.get(
    '/api/empresa/:ref/unidades',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const emp = await findEmpresa(String(req.params.ref));
      if (!emp) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerir(req, emp.id)) return res.status(403).json({ error: 'Sem permissão.' });

      await ensureUnidadesSchema(getDb());
      const items = await listUnidades(emp.id);
      res.json({
        permitido: planPermiteUnidades(emp.plan),
        plan: emp.plan,
        items: items || [],
        total: (items || []).length,
      });
    })
  );

  app.post(
    '/api/empresa/:ref/unidades',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const emp = await findEmpresa(String(req.params.ref));
      if (!emp) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerir(req, emp.id)) {
        return res.status(403).json({
          error: 'Sem permissão. Faça login com a conta desta empresa.',
        });
      }

      if (!planPermiteUnidades(emp.plan)) {
        return res.status(403).json({
          error: 'Multi-unidades disponível nos planos Corporativo, Rei ou trial.',
          plan: emp.plan,
        });
      }

      const nome = String(req.body?.nome || '').trim();
      if (!nome || nome.length < 2) {
        return res.status(400).json({ error: 'Informe o nome da unidade (mín. 2 caracteres).' });
      }

      await ensureUnidadesSchema(getDb());
      const existing = await listUnidades(emp.id);
      const max = String(emp.plan).toLowerCase() === 'rei' ? 50 : 15;
      if ((existing || []).length >= max) {
        return res.status(400).json({ error: `Limite de ${max} unidades neste plano.` });
      }

      try {
        const row = await createUnidade({
          empresaId: emp.id,
          nome,
          endereco: req.body?.endereco || null,
          cidade: req.body?.cidade || null,
          google_place_id: req.body?.google_place_id || null,
          google_review_url: req.body?.google_review_url || null,
        });
        res.status(201).json({ success: true, unidade: row });
      } catch (e: any) {
        console.error('[unidades] create:', e);
        const status = Number(e?.status) || 500;
        res.status(status).json({
          error: e?.message || 'Falha ao criar unidade.',
          detail: process.env.NODE_ENV !== 'production' ? String(e?.message || e) : undefined,
        });
      }
    })
  );

  app.delete(
    '/api/empresa/:ref/unidades/:unidadeId',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const emp = await findEmpresa(String(req.params.ref));
      if (!emp) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerir(req, emp.id)) return res.status(403).json({ error: 'Sem permissão.' });

      const ok = await softDeleteUnidade(String(req.params.unidadeId), emp.id);
      if (!ok) return res.status(404).json({ error: 'Unidade não encontrada.' });
      res.json({ success: true });
    })
  );
}
