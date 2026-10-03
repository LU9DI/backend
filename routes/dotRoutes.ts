import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { callAI } from '../groqService.js';
import { prepareDotAction } from '../services/dotTools.js';
import { loadDotRealContext } from '../services/dotContext.js';
import { getDotPreferences, saveDotPreferences } from '../services/dotPreferences.js';
import { listDotEvents, runDotMonitor } from '../services/dotMonitor.js';
import { resolveDotComplaint } from '../services/dotResolve.js';
import { createDecisionsForEvents, listDotDecisions, updateDotDecision } from '../services/dotDecision.js';
import { prepareDotActionFromDecision, approveDotAction, executeDotAction, listDotActions } from '../services/dotActionQueue.js';
import { listDotFollowUps, completeDotFollowUp } from '../services/dotFollowUp.js';
import { extrairToken, verifyAccessToken, isAdminUser } from '../lib/auth.js';
import { findEmpresa } from '../lib/db.js';
import { planLabel } from '../lib/plans.js';
import { empresaTemAcesso } from '../services/billingService.js';
import { getDotSchedulerStatus } from '../services/dotScheduler.js';

const dotLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas mensagens. Aguarde um momento.' },
});

const SYSTEM = `Você é o Filtra Dot, o agente inteligente de reputação e crescimento do Filtra.AI.
Você fala em português do Brasil, de forma clara, objetiva e útil.
Você conhece o contexto demonstrativo abaixo e deve deixar claro quando estiver usando dados de demonstração.
Seu papel é analisar avaliações, feedback, reputação, tendências e sugerir ações práticas.
Não invente números, clientes, avaliações ou integrações que não estejam no contexto.
Você pode planejar ações, mas nunca deve afirmar que enviou mensagens, publicou respostas, alterou CRM ou executou uma ação externa se nenhuma ferramenta realmente a executou.
Quando uma ação externa seria necessária, explique que ela precisa de autorização/execução da plataforma.
Responda como um agente, não como um chatbot genérico: use o histórico da conversa, identifique o próximo passo e, quando apropriado, termine com uma ação concreta que você pode preparar.`;

const DEMO_CONTEXT = `
EMPRESA DEMO: Hotel Aurora
PLANO: Rei
DADOS DEMONSTRATIVOS:
- Nota média: 4,8/5
- Avaliações: 1.284
- Positivas: 91%
- Alertas ativos: 37
- Tendência: +18,4% nos últimos 14 dias
- Sinais recentes: elogios ao atendimento; reclamações sobre tempo de espera; equipe frequentemente elogiada
- O Filtra.AI já possui módulos de avaliações, IA, alertas, relatórios e CRM.
IMPORTANTE: estes números são apenas para o protótipo local e não representam dados reais do cliente.
`;

type ChatItem = { role: 'user' | 'dot'; text: string; at: number };
type DotAccess = {
  allowed: boolean;
  demo: boolean;
  empresaId?: string;
  plan?: string;
  planLabel?: string;
  reason?: string;
};

const sessions = new Map<string, ChatItem[]>();
const MAX_HISTORY = 12;

// Estado efêmero do protótipo local. Nunca é usado para empresas autenticadas
// e não representa dados persistidos de clientes.
const demoActions = new Map<number, {
  id: number;
  decisionId: number;
  optionId: string;
  action: string;
  status: 'prepared' | 'approved' | 'executed';
  demo: true;
}>();
let nextDemoActionId = 1;

function cleanMessage(value: unknown): string {
  return String(value ?? '').trim().slice(0, 4000);
}

function scopedSessionId(access: DotAccess, id: string): string {
  const safeId = id || 'local-demo';
  return access.empresaId ? `${access.empresaId}:${safeId}` : `demo:${safeId}`;
}

function sessionHistory(id: string): ChatItem[] {
  const current = sessions.get(id);
  if (current) return current;
  const created: ChatItem[] = [];
  sessions.set(id, created);
  return created;
}

function resetSession(id: string) {
  sessions.delete(id);
}

function buildConversation(context: string, history: ChatItem[], message: string): string {
  const transcript = history
    .slice(-MAX_HISTORY)
    .map((item) => `${item.role === 'user' ? 'USUÁRIO' : 'FILTRA DOT'}: ${item.text}`)
    .join('\n');
  return [context, transcript, `USUÁRIO: ${message}`].filter(Boolean).join('\n\n');
}

async function resolveDotAccess(req: Request): Promise<DotAccess> {
  // No ambiente local, o protótipo demo deve funcionar de forma determinística
  // em loopback, mesmo que o cliente tenha um cookie/token residual.
  const isLocalDemo =
    process.env.NODE_ENV !== 'production' &&
    (req.hostname === '127.0.0.1' || req.hostname === 'localhost');
  if (isLocalDemo) {
    return { allowed: true, demo: true, plan: 'rei', planLabel: 'Rei' };
  }

  const token = extrairToken(req);

  if (!token) {
    return { allowed: false, demo: false, reason: 'Autenticação necessária.' };
  }

  try {
    const payload = verifyAccessToken(token);
    if (isAdminUser({ empresa_id: payload.empresa_id, role: payload.role })) {
      return { allowed: false, demo: false, reason: 'Conta admin não possui acesso ao Dot de empresa.' };
    }

    const empresa = await findEmpresa(payload.empresa_id);
    if (!empresa || !empresaTemAcesso(empresa)) {
      return { allowed: false, demo: false, reason: 'Assinatura/trial inativo.' };
    }

    const plan = String(empresa.plan || '').toLowerCase();
    const liberado = plan === 'rei' || plan === 'corporativo' || plan === 'corp';
    if (!liberado) {
      return {
        allowed: false,
        demo: false,
        empresaId: empresa.id,
        plan,
        planLabel: planLabel(plan),
        reason: 'O Filtra Dot está em acesso antecipado para os planos Rei e Corporativo.',
      };
    }

    return {
      allowed: true,
      demo: false,
      empresaId: empresa.id,
      plan,
      planLabel: planLabel(plan),
    };
  } catch {
    return { allowed: false, demo: false, reason: 'Token inválido ou expirado.' };
  }
}

function deny(res: Response, access: DotAccess) {
  return res.status(403).json({
    ok: false,
    error: access.reason || 'Acesso ao Filtra Dot não liberado.',
    code: 'DOT_PLAN_REQUIRED',
    allowedPlans: ['rei', 'corporativo'],
  });
}

export function mountDotRoutes(app: Express) {
  app.get('/api/dot/status', async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    res.json({
      ok: true,
      enabled:
        access.allowed &&
        (process.env.NODE_ENV !== 'production' || process.env.FILTRA_DOT_ENABLED === '1'),
      access: access.allowed,
      demo: access.demo,
      plan: access.plan || 'rei',
      plan_label: access.planLabel || 'Rei',
      priority_access: ['rei', 'corporativo'],
      scheduler: getDotSchedulerStatus(),
      capabilities: [
        'analisar_reputacao',
        'detectar_padroes',
        'explicar_tendencias',
        'preparar_acoes',
        'memoria_de_conversa',
      ],
    });
  });

  app.get('/api/dot/preferences', async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed || !access.empresaId) return deny(res, access);
    const preferences = await getDotPreferences(access.empresaId);
    res.json({ ok: true, plan: access.plan, preferences });
  });

  app.put('/api/dot/preferences', async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed || !access.empresaId) return deny(res, access);
    const preferences = await saveDotPreferences(access.empresaId, req.body || {});
    res.json({ ok: true, plan: access.plan, preferences });
  });

  app.post('/api/dot/monitor/run', dotLimiter, async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed) return deny(res, access);

    // O modo demo local não possui empresa autenticada. Não bloqueie o teste
    // funcional do endpoint por exigir empresaId; devolva uma simulação explícita
    // e não persista eventos/decisões como se fossem dados reais.
    if (access.demo) {
      const result = {
        ok: true,
        skipped: false,
        demo: true,
        average: 4.8,
        events: [
          {
            id: null,
            type: 'recurring_theme',
            severity: 'warning',
            title: 'Tema recorrente detectado',
            details: 'No cenário demonstrativo, o tema "tempo de espera" aparece de forma recorrente e merece investigação.',
          },
        ],
        decisions: [
          {
            id: null,
            eventId: null,
            type: 'monitoramento',
            priority: 'alta',
            severity: 'warning',
            reason: 'O tema recorrente deve ser acompanhado antes de qualquer ação externa.',
            evidence: ['Cenário demonstrativo do Filtra Dot'],
            recommendation: 'Investigar a causa e acompanhar a evolução.',
            options: [
              {
                id: 'opcao_1',
                title: 'Acompanhar e corrigir',
                description: 'Atuar sobre a causa identificada e acompanhar o resultado.',
                action: 'corrigir_e_acompanhar',
                risk: 'medio',
              },
              {
                id: 'opcao_2',
                title: 'Escalar para responsável',
                description: 'Encaminhar com contexto e evidências para validação.',
                action: 'escalar_responsavel',
                risk: 'baixo',
              },
            ],
            requiresApproval: true,
            status: 'pending',
          },
        ],
        prepared_actions: [],
        policy: {
          prepareAction: true,
          requiresApproval: true,
        },
      };
      return res.json({ ok: true, demo: true, result });
    }

    const result = await runDotMonitor(access.empresaId);
    res.json({ ok: true, demo: false, result });
  });

  app.get('/api/dot/decisions', async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed || !access.empresaId) return deny(res, access);
    const decisions = await listDotDecisions(access.empresaId);
    res.json({ ok: true, decisions });
  });

  // Rota específica vem antes da rota genérica para evitar colisão com :action.
  app.post('/api/dot/decisions/:id/prepare-action', async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed) return deny(res, access);
    const optionId = String(req.body?.optionId || '');
    if (!['opcao_1', 'opcao_2'].includes(optionId)) return res.status(400).json({ error: 'Opção inválida.' });
    if (access.demo) {
      const decisionId = Number(req.params.id);
      if (decisionId !== 1) return res.status(404).json({ error: 'Decisão demo não encontrada.' });
      const existing = Array.from(demoActions.values()).find((item) => item.decisionId === decisionId);
      if (existing) return res.json({ ok: true, demo: true, action: existing, executed: false });
      const action = {
        id: nextDemoActionId++,
        decisionId,
        optionId,
        action: optionId === 'opcao_1' ? 'corrigir_e_acompanhar' : 'escalar_responsavel',
        status: 'prepared' as const,
        demo: true as const,
      };
      demoActions.set(action.id, action);
      return res.json({ ok: true, demo: true, action, executed: false });
    }
    if (!access.empresaId) return deny(res, access);
    const action = await prepareDotActionFromDecision(access.empresaId, Number(req.params.id), optionId);
    if (!action) return res.status(404).json({ error: 'Decisão ou opção não encontrada.' });
    res.json({ ok: true, action, executed: false });
  });

  app.post('/api/dot/decisions/:id/:action', async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed || !access.empresaId) return deny(res, access);
    const action = String(req.params.action);
    // Aprovação de uma ação só pode ocorrer pela fila de ações, que exige
    // uma ação preparada e aplica a transação atômica decisão + ação.
    if (!['prepare', 'reject'].includes(action)) {
      return res.status(409).json({
        error: 'Aprovação deve ocorrer pela fila de ações.',
        code: 'DOT_APPROVAL_REQUIRES_ACTION',
      });
    }
    const status = action === 'prepare' ? 'prepared' : 'rejected';
    const result = await updateDotDecision(access.empresaId, Number(req.params.id), status as any);
    if (!result) return res.status(404).json({ error: 'Decisão não encontrada.' });
    res.json({ ok: true, decision: result, executed: false });
  });

  app.get('/api/dot/actions', async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed) return deny(res, access);
    if (access.demo) {
      return res.json({ ok: true, demo: true, actions: Array.from(demoActions.values()) });
    }
    if (!access.empresaId) return deny(res, access);
    res.json({ ok: true, actions: await listDotActions(access.empresaId) });
  });

  app.post('/api/dot/actions/:id/approve', async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed) return deny(res, access);
    if (access.demo) {
      const id = Number(req.params.id);
      const action = demoActions.get(id);
      if (!action || action.status !== 'prepared') return res.status(409).json({ error: 'Ação demo não encontrada ou já processada.' });
      action.status = 'approved';
      return res.json({ ok: true, demo: true, action });
    }
    if (!access.empresaId) return deny(res, access);
    const action = await approveDotAction(access.empresaId, Number(req.params.id));
    if (!action) return res.status(409).json({ error: 'Ação não encontrada ou já processada.' });
    res.json({ ok: true, action });
  });

  app.post('/api/dot/actions/:id/run', async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed) return deny(res, access);
    if (access.demo) {
      const id = Number(req.params.id);
      const action = demoActions.get(id);
      if (!action || action.status !== 'approved') return res.status(409).json({ ok: false, error: 'Ação demo precisa estar aprovada antes da execução.' });
      action.status = 'executed';
      return res.json({ ok: true, demo: true, action, external_side_effect: false });
    }
    if (!access.empresaId) return deny(res, access);
    const result = await executeDotAction(access.empresaId, Number(req.params.id));
    if (!result.ok) return res.status(409).json(result);
    res.json({ ok: true, action: result, external_side_effect: false });
  });

  app.get('/api/dot/cases', async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed || !access.empresaId) return deny(res, access);
    const db = (await import('../lib/db.js')).getDb();
    await db.exec(`CREATE TABLE IF NOT EXISTS dot_internal_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT NOT NULL,
      decision_id INTEGER NOT NULL,
      action_id INTEGER NOT NULL,
      event_id INTEGER,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      summary TEXT NOT NULL,
      next_step TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    const cases = await db.all(
      'SELECT * FROM dot_internal_cases WHERE empresa_id = ? ORDER BY CASE WHEN status IN (\'prioritized\',\'escalated\') THEN 0 ELSE 1 END, id DESC LIMIT 100',
      [access.empresaId],
    );
    res.json({ ok: true, cases: cases || [] });
  });

  app.get('/api/dot/followups', async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed || !access.empresaId) return deny(res, access);
    res.json({ ok: true, followups: await listDotFollowUps(access.empresaId) });
  });

  app.post('/api/dot/followups/:id/complete', async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed || !access.empresaId) return deny(res, access);
    const outcome = cleanMessage(req.body?.outcome);
    const followUp = await completeDotFollowUp(access.empresaId, Number(req.params.id), outcome);
    if (!followUp) return res.status(409).json({ error: 'Acompanhamento não encontrado ou já concluído.' });
    res.json({ ok: true, followup: followUp });
  });

  app.post('/api/dot/resolve', dotLimiter, async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed) return deny(res, access);
    const complaint = cleanMessage(req.body?.complaint || req.body?.message);
    if (!complaint) return res.status(400).json({ error: 'Relato do cliente é obrigatório.' });
    if (!access.empresaId) {
      return res.json({
        ok: true,
        demo: true,
        result: {
          problem_summary: complaint,
          verification_status: 'unverified',
          confidence: 'baixa',
          facts: [{ source: 'modo demonstração', fact: 'O Dot Resolve precisa de uma empresa autenticada para verificar dados reais.' }],
          evidence: [],
          options: [
            { id: 'opcao_1', title: 'Investigar e acompanhar', description: 'Validar o caso com os dados da empresa antes de agir.', action: 'corrigir_e_acompanhar', risk: 'medio' },
            { id: 'opcao_2', title: 'Escalar para responsável', description: 'Deixar a validação final com o responsável da empresa.', action: 'escalar_responsavel', risk: 'baixo' },
          ],
          requires_owner_decision: true,
        },
      });
    }
    const result = await resolveDotComplaint(access.empresaId, complaint);
    const db = (await import('../lib/db.js')).getDb();
    await db.exec(`CREATE TABLE IF NOT EXISTS dot_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL,
      acknowledged_at TEXT
    )`);
    const severity = result.verification_status === 'confirmed' ? 'critical' : 'warning';
    const eventTitle = result.verification_status === 'confirmed'
      ? 'Reclamação confirmada pelo Dot Resolve'
      : 'Reclamação recebida para verificação';
    const eventDetails = [
      result.problem_summary,
      ...result.facts.map((fact) => fact.fact),
      result.evidence.length ? `Evidências relacionadas: ${result.evidence.length}.` : 'Nenhuma evidência relacionada encontrada.',
    ].join(' ');
    const inserted = await db.run(
      'INSERT INTO dot_events (empresa_id,type,severity,title,details,created_at) VALUES (?,?,?,?,?,?) RETURNING id',
      [access.empresaId, 'complaint_resolution', severity, eventTitle, eventDetails, new Date().toISOString()]
    );
    const decisions = await createDecisionsForEvents(access.empresaId, [{ id: inserted.lastID, type: 'complaint_resolution', severity, title: eventTitle, details: eventDetails }]);
    const decision = decisions[0];
    let preparedAction = null;
    if (decision?.id) {
      const preferences = await getDotPreferences(access.empresaId);
      if (preferences.prepareActionsAutomatically && preferences.autonomy !== 'observador') {
        preparedAction = await prepareDotActionFromDecision(
          access.empresaId,
          Number(decision.id),
          String(result.options[0]?.id || 'opcao_1'),
        );
      }
    }
    res.json({
      ok: true,
      demo: access.demo,
      result: {
        ...result,
        decision_id: decision?.id,
        prepared_action: preparedAction,
      },
    });
  });

  app.get('/api/dot/events', async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed || !access.empresaId) return deny(res, access);
    const events = await listDotEvents(access.empresaId);
    res.json({ ok: true, events });
  });

  app.post('/api/dot/events/:id/ack', async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed || !access.empresaId) return deny(res, access);
    const db = (await import('../lib/db.js')).getDb();
    await db.run('UPDATE dot_events SET acknowledged_at = ? WHERE id = ? AND empresa_id = ?', [new Date().toISOString(), String(req.params.id), access.empresaId]);
    res.json({ ok: true });
  });

  app.get('/api/dot/briefing', async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed) return deny(res, access);

    const context = access.demo
      ? DEMO_CONTEXT
      : await loadDotRealContext(access.empresaId as string);

    res.json({
      ok: true,
      demo: access.demo,
      plan: access.plan || 'rei',
      plan_label: access.planLabel || 'Rei',
      context,
      briefing: access.demo
        ? {
            headline: 'A reputação está saudável, mas existe um sinal recorrente para investigar.',
            trend: '+18,4%',
            rating: '4,8/5',
            reviews: 1284,
            priority: 'Tempo de espera',
            reason: 'As reclamações recentes apontam repetição do mesmo tema.',
            suggestedAction: 'Analisar as avaliações afetadas e preparar um plano para a equipe.',
          }
        : {
            headline: 'Briefing calculado a partir das avaliações reais da empresa.',
            suggestedAction: 'Peça ao Dot para analisar os principais temas e preparar o próximo passo.',
          },
    });
  });

  app.post('/api/dot/action/prepare', dotLimiter, async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed) return deny(res, access);

    const action = cleanMessage(req.body?.action);
    if (!action) return res.status(400).json({ error: 'Ação obrigatória.' });

    return res.json({
      ok: true,
      demo: access.demo,
      plan: access.plan || 'rei',
      proposal: prepareDotAction(action, access.demo),
    });
  });

  app.delete('/api/dot/session/:sessionId', async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed) return deny(res, access);

    resetSession(scopedSessionId(access, String(req.params.sessionId || '')));
    res.json({ ok: true });
  });

  app.post('/api/dot/chat', dotLimiter, async (req: Request, res: Response) => {
    const access = await resolveDotAccess(req);
    if (!access.allowed) return deny(res, access);

    if (process.env.NODE_ENV === 'production' && process.env.FILTRA_DOT_ENABLED !== '1') {
      return res.status(404).json({ error: 'Filtra Dot ainda não está habilitado.' });
    }

    const message = cleanMessage(req.body?.message);
    const requestedSessionId = cleanMessage(req.body?.session_id) || 'local-demo';
    if (!message) return res.status(400).json({ error: 'Mensagem obrigatória.' });

    const sessionId = scopedSessionId(access, requestedSessionId);
    const history = sessionHistory(sessionId);

    try {
      const context = access.demo
        ? DEMO_CONTEXT
        : await loadDotRealContext(access.empresaId as string);

      const result = await callAI(
        SYSTEM,
        buildConversation(context, history, message),
        700,
        0.45,
        { empresaId: access.empresaId || null, tipo: 'filtra_dot_chat' }
      );

      history.push({ role: 'user', text: message, at: Date.now() });
      history.push({ role: 'dot', text: result.text, at: Date.now() });
      while (history.length > MAX_HISTORY) history.shift();

      return res.json({
        ok: true,
        message: result.text,
        provider: result.provider,
        latency_ms: result.latency_ms,
        tokens_used: result.tokens,
        demo: access.demo,
        plan: access.plan || 'rei',
        plan_label: access.planLabel || 'Rei',
        session_id: requestedSessionId,
        memory_turns: Math.floor(history.length / 2),
      });
    } catch (error: any) {
      console.error('[Filtra Dot]', error?.message || error);
      return res.status(503).json({
        error: 'O Filtra Dot está sem um provedor de IA disponível no localhost.',
        detail: process.env.NODE_ENV === 'production' ? undefined : String(error?.message || error),
      });
    }
  });
}
