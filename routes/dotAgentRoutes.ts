import type { Express, Request, Response } from 'express';
import { planLabel } from '../lib/plans.js';
import { createDotAgentGoal, getDotAgentWorkspace, listDotAgentGoals, updateDotAgentGoal } from '../services/dotAgent.js';
import { createMissionForGoal } from '../services/dotAgentMissions.js';
import { wakeDotAgentWorker } from '../services/dotAgentWorker.js';
import { resolveDotGate } from '../services/dotAccessGate.js';
import { requireDotAccess, type DotAccessAction, type DotAccessResource } from '../services/dotAccessControl.js';
import { listDotActionDefinitions, type DotActionChannel } from '../services/dotActionRegistry.js';

type DotAgentAccess = { allowed: boolean; empresaId?: string; plan?: string; reason?: string; userId?: string | null; demo?: boolean };

// Canais que o Dot conhece. O status é derivado do registro real de executores:
// hoje só existe executor interno homologado pelo gateway de execução.
const DOT_CHANNELS: Array<{ channel: DotActionChannel; label: string }> = [
  { channel: 'internal', label: 'Execução interna' },
  { channel: 'whatsapp', label: 'WhatsApp' },
  { channel: 'google_reviews', label: 'Google Reviews' },
  { channel: 'crm', label: 'CRM' },
  { channel: 'email', label: 'E-mail' },
];

// Regra única de entrada no Dot (auth + assinatura/trial + plano Rei/Corporativo).
async function resolveDotAgentAccess(req: Request): Promise<DotAgentAccess> {
  const gate = await resolveDotGate(req);
  return {
    allowed: gate.allowed,
    empresaId: gate.empresaId,
    plan: gate.plan,
    reason: gate.reason,
    userId: gate.userId,
    demo: gate.demo,
  };
}

async function requireAgentMutation(res: Response, access: DotAgentAccess, resource: DotAccessResource, action: DotAccessAction): Promise<boolean> {
  if (access.demo || !access.empresaId || !access.userId) {
    res.status(403).json({
      ok: false,
      error: 'Permissão autenticada é necessária para alterar objetivos do agente DOT.',
      code: 'DOT_PERMISSION_REQUIRED',
      resource,
      action,
    });
    return false;
  }
  try {
    await requireDotAccess(access.empresaId, resource, action, access.userId, { route: 'dot/agent', action });
    return true;
  } catch (error) {
    res.status(403).json({ ok: false, error: error instanceof Error ? error.message : 'Permissão DOT insuficiente.', code: 'DOT_PERMISSION_REQUIRED', resource, action });
    return false;
  }
}

function deny(res: Response, access: DotAgentAccess) {
  return res.status(403).json({ ok: false, error: access.reason || 'Acesso ao agente DOT não liberado.', code: 'DOT_AGENT_PLAN_REQUIRED', allowedPlans: ['rei', 'corporativo'] });
}

export function mountDotAgentRoutes(app: Express) {
  app.get('/api/dot/agent/workspace', async (req: Request, res: Response) => {
    const access = await resolveDotAgentAccess(req);
    if (!access.allowed || !access.empresaId) return deny(res, access);
    try {
      res.json({ ok: true, ...await getDotAgentWorkspace(access.empresaId), plan: access.plan, plan_label: planLabel(access.plan || '') });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Falha ao carregar o espaço do agente DOT.' });
    }
  });

  /**
   * Estado real das integrações do Dot.
   *
   * Não existe integração externa homologada: todos os executores registrados
   * são internos (`externalSideEffect: false`). A rota informa exatamente isso,
   * em vez de anunciar canais que não existem.
   */
  app.get('/api/dot/agent/integrations', async (req: Request, res: Response) => {
    const access = await resolveDotAgentAccess(req);
    if (!access.allowed || !access.empresaId) return deny(res, access);
    try {
      const definitions = listDotActionDefinitions();
      const integrations = DOT_CHANNELS.map(({ channel, label }) => {
        const supporting = definitions.filter((definition) => definition.channels.includes(channel));
        const hasInternalExecutor = supporting.some((definition) => !definition.externalSideEffect);
        return {
          provider: channel,
          label,
          status: hasInternalExecutor ? 'internal_only' : 'not_configured',
          actions: supporting.map((definition) => definition.action),
        };
      });
      res.json({ ok: true, integrations });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Falha ao carregar integrações do DOT.' });
    }
  });

  app.get('/api/dot/agent/goals', async (req: Request, res: Response) => {
    const access = await resolveDotAgentAccess(req);
    if (!access.allowed || !access.empresaId) return deny(res, access);
    try {
      res.json({ ok: true, goals: await listDotAgentGoals(access.empresaId) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Falha ao carregar objetivos.' });
    }
  });

  app.post('/api/dot/agent/goals', async (req: Request, res: Response) => {
    const access = await resolveDotAgentAccess(req);
    if (!access.allowed || !access.empresaId) return deny(res, access);
    if (!(await requireAgentMutation(res, access, 'operations', 'create'))) return;
    try {
      const goal = await createDotAgentGoal(access.empresaId, req.body || {});
      const mission = await createMissionForGoal(access.empresaId, goal.id, goal.title);
      void wakeDotAgentWorker();
      res.status(201).json({ ok: true, goal, mission });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : 'Não foi possível criar o objetivo.' });
    }
  });

  app.patch('/api/dot/agent/goals/:id', async (req: Request, res: Response) => {
    const access = await resolveDotAgentAccess(req);
    if (!access.allowed || !access.empresaId) return deny(res, access);
    if (!(await requireAgentMutation(res, access, 'operations', 'update'))) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'ID de objetivo inválido.' });
    try {
      const goal = await updateDotAgentGoal(access.empresaId, id, req.body || {});
      if (!goal) return res.status(404).json({ ok: false, error: 'Objetivo não encontrado.' });
      res.json({ ok: true, goal });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : 'Não foi possível atualizar o objetivo.' });
    }
  });
}
