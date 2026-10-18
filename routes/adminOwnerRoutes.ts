/**
 * Provisionamento do proprietário da empresa — admin da plataforma.
 *
 * Empresas criadas antes do vínculo de propriedade (ou com correção
 * necessária) só recebem proprietário por aqui: operação autenticada
 * (conta admin da plataforma), auditada e validada contra o banco (o usuário
 * precisa existir E pertencer à empresa). Nenhuma heurística automática.
 */
import type { Express, Response } from 'express';
import { getDb, findEmpresa } from '../lib/db.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getEmpresaOwner, provisionEmpresaOwner } from '../lib/empresaOwnership.js';
import { clientIp } from '../lib/auditLog.js';

function requirePlatformAdmin(req: AuthRequest, res: Response): boolean {
  if (!isAdminUser(req.user)) {
    res.status(403).json({ error: 'Acesso negado.' });
    return false;
  }
  return true;
}

export function mountAdminOwnerRoutes(app: Express) {
  app.get(
    '/api/admin/empresas/:ref/owner',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requirePlatformAdmin(req, res)) return;
      const empresa = await findEmpresa(String(req.params.ref || ''));
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      const owner = await getEmpresaOwner(empresa.id);
      if (!owner) return res.json({ ok: true, empresa_id: empresa.id, owner: null });
      const usuario = await getDb().get(
        'SELECT id, email, nome_funcionario FROM usuarios WHERE id = ? LIMIT 1',
        [owner.user_id],
      );
      res.json({
        ok: true,
        empresa_id: empresa.id,
        owner: {
          user_id: owner.user_id,
          email: usuario?.email || null,
          nome_funcionario: usuario?.nome_funcionario || null,
          provisioned_by: owner.provisioned_by,
          updated_at: owner.updated_at,
        },
      });
    }),
  );

  app.post(
    '/api/admin/empresas/:ref/owner',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requirePlatformAdmin(req, res)) return;
      const empresa = await findEmpresa(String(req.params.ref || ''));
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      const db = getDb();
      const userId = String(req.body?.user_id || '').trim();
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!userId && !email) {
        return res.status(400).json({ error: 'Informe user_id ou email do responsável.' });
      }
      const usuario = userId
        ? await db.get('SELECT id, empresa_id FROM usuarios WHERE id = ? LIMIT 1', [userId])
        : await db.get('SELECT id, empresa_id FROM usuarios WHERE lower(email) = lower(?) LIMIT 1', [email]);
      if (!usuario) return res.status(404).json({ error: 'Usuário não encontrado.' });
      if (String(usuario.empresa_id) !== String(empresa.id)) {
        return res.status(400).json({ error: 'Este usuário não pertence à empresa informada.' });
      }
      const owner = await provisionEmpresaOwner(empresa.id, usuario.id, {
        actorUserId: req.user?.id || null,
        source: 'admin',
        ip: clientIp(req),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
      });
      res.json({
        ok: true,
        empresa_id: empresa.id,
        owner: { user_id: owner.user_id, updated_at: owner.updated_at },
      });
    }),
  );
}
