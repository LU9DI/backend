import type { Express, Request, Response } from 'express';
import { resolveDotGate } from '../services/dotAccessGate.js';
import { listDotPermissions, setDotPermission, type DotAccessAction, type DotAccessResource } from '../services/dotAccessControl.js';
import { listDotTools, invokeDotTool } from '../services/dotToolRegistry.js';

const resources: DotAccessResource[] = ['filtra','customers','sales','marketing','operations','finance','hr','crm','documents','calendar','email','whatsapp','erp','other'];
const actions: DotAccessAction[] = ['read','analyze','create','update','execute','external_send'];

// Regra única de entrada no Dot (auth + assinatura/trial + plano).
// A mesma função é usada por /api/dot/* e /api/dot/agent/*.
async function access(req: Request) {
  const gate = await resolveDotGate(req);
  return {
    ok: gate.allowed,
    empresaId: gate.empresaId,
    userId: gate.userId,
    canManagePermissions: gate.canManagePermissions,
    demo: gate.demo,
    reason: gate.reason,
  };
}

export function mountDotAccessRoutes(app: Express) {
  app.get('/api/dot/agent/permissions', async (req: Request, res: Response) => {
    const a = await access(req);
    if (!a.ok || !a.empresaId) return res.status(403).json({ ok: false, error: a.reason });
    res.json({ ok: true, permissions: await listDotPermissions(a.empresaId, a.userId), can_manage: Boolean(a.canManagePermissions), demo: Boolean(a.demo) });
  });

  app.put('/api/dot/agent/permissions', async (req: Request, res: Response) => {
    const a = await access(req);
    if (!a.ok || !a.empresaId) return res.status(403).json({ ok: false, error: a.reason });
    if (a.demo || !a.canManagePermissions || !a.userId) {
      return res.status(403).json({ ok: false, error: 'Somente um responsável autenticado pela conta pode alterar permissões do DOT.', code: 'DOT_PERMISSION_ADMIN_REQUIRED' });
    }
    const { resource, action, granted } = req.body || {};
    if (!resources.includes(resource) || !actions.includes(action) || typeof granted !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'Permissão inválida.', resources, actions });
    }
    const permission = await setDotPermission(a.empresaId, { resource, action, granted, grantedBy: a.userId });
    res.json({ ok: true, permission });
  });

  app.get('/api/dot/agent/tools', async (req: Request, res: Response) => {
    const a = await access(req);
    if (!a.ok || !a.empresaId) return res.status(403).json({ ok: false, error: a.reason });
    res.json({ ok: true, tools: listDotTools(), demo: Boolean(a.demo) });
  });

  app.post('/api/dot/agent/tools/:toolId/invoke', async (req: Request, res: Response) => {
    const a = await access(req);
    if (!a.ok || !a.empresaId) return res.status(403).json({ ok: false, error: a.reason });
    try {
      const toolId = String(req.params.toolId || '');
      const result = await invokeDotTool({
        empresaId: a.empresaId,
        toolId,
        actorType: 'user',
        actorUserId: a.userId,
        input: req.body || {},
      });
      res.json(result);
    } catch (error) {
      res.status(403).json({ ok: false, error: error instanceof Error ? error.message : 'Ferramenta DOT não autorizada.' });
    }
  });
}
