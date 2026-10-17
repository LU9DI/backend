import { getDb } from '../lib/db.js';
import { dotActionRequiresApproval, getDotActionDefinition } from './dotActionRegistry.js';
import { evaluateDotPolicy, type DotRisk } from './dotPolicy.js';
import { getDotPreferences } from './dotPreferences.js';
import { recordDotActionAudit } from './dotActionAudit.js';
import { createDotFollowUp } from './dotFollowUp.js';
import { requireDotAccess, type DotAccessResource } from './dotAccessControl.js';
import { executeDotInternalAction } from './dotInternalExecutors.js';

export type DotExecutionResult = {
  ok: boolean;
  id: number;
  status: string;
  simulated: boolean;
  executor: string;
  startedAt: string;
  executedAt?: string;
  reason?: string;
};

function riskForAction(risk: string): DotRisk {
  if (risk === 'baixo') return 'low';
  if (risk === 'alto') return 'high';
  return 'medium';
}

/**
 * Único gateway de execução do Dot.
 *
 * Todo executor futuro (CRM, WhatsApp, Google Reviews, e-mail etc.) deve
 * passar por este ponto. O gateway valida tenant, definição, política e
 * aprovação antes de entregar a execução ao executor registrado.
 */
export async function executeDotActionThroughGateway(
  empresaId: string,
  actionId: number,
  actorUserId?: string | null,
): Promise<DotExecutionResult> {
  const db = getDb();
  const row = await db.get(
    `SELECT a.*, d.status AS decision_status, d.requires_approval
       FROM dot_action_queue a
       JOIN dot_decisions d ON d.id = a.decision_id AND d.empresa_id = a.empresa_id
      WHERE a.id = ? AND a.empresa_id = ? AND a.status = 'approved' LIMIT 1`,
    [actionId, empresaId],
  );

  if (!row) {
    return { ok: false, id: actionId, status: 'approved', simulated: true, executor: '', startedAt: '', reason: 'Ação não encontrada ou não aprovada.' };
  }

  if (String(row.decision_status) !== 'approved' || Number(row.requires_approval) !== 1) {
    return { ok: false, id: actionId, status: String(row.status), simulated: true, executor: '', startedAt: '', reason: 'A decisão vinculada não está aprovada para execução.' };
  }

  const definition = getDotActionDefinition(String(row.action));
  if (!definition) {
    return { ok: false, id: actionId, status: String(row.status), simulated: true, executor: '', startedAt: '', reason: 'Executor não registrado para esta ação.' };
  }

  const permissionResource: DotAccessResource = definition.channels.includes('crm') ? 'crm'
    : definition.channels.includes('email') ? 'email'
      : definition.channels.includes('whatsapp') ? 'whatsapp'
        : definition.channels.includes('google_reviews') ? 'marketing'
          : 'operations';
  try {
    await requireDotAccess(empresaId, permissionResource, 'execute', actorUserId || null, { actionId, action: definition.action, executor: definition.executorKey });
  } catch (error: any) {
    return {
      ok: false,
      id: actionId,
      status: String(row.status),
      simulated: true,
      executor: definition.executorKey,
      startedAt: '',
      reason: error?.message || 'Permissão de execução do DOT não concedida.',
    };
  }

  if (!dotActionRequiresApproval(definition.action)) {
    return { ok: false, id: actionId, status: String(row.status), simulated: true, executor: definition.executorKey, startedAt: '', reason: 'A ação não está protegida por aprovação explícita.' };
  }

  const preferences = await getDotPreferences(empresaId);
  const policy = evaluateDotPolicy(preferences, riskForAction(definition.risk));
  if (!policy.observe || !policy.requiresApproval) {
    return { ok: false, id: actionId, status: String(row.status), simulated: true, executor: definition.executorKey, startedAt: '', reason: 'A política do Dot não autoriza esta execução.' };
  }

  if (definition.externalSideEffect) {
    return { ok: false, id: actionId, status: String(row.status), simulated: true, executor: definition.executorKey, startedAt: '', reason: 'Ação externa exige executor homologado pelo gateway.' };
  }

  const startedAt = new Date().toISOString();
  const claimed = await db.run(
    "UPDATE dot_action_queue SET status = 'executing', error = NULL WHERE id = ? AND empresa_id = ? AND status = 'approved'",
    [actionId, empresaId],
  );
  if (!claimed || claimed.changes !== 1) {
    return { ok: false, id: actionId, status: 'approved', simulated: true, executor: definition.executorKey, startedAt, reason: 'Ação já está sendo processada ou mudou de estado.' };
  }

  await recordDotActionAudit({
    empresaId,
    actionId,
    decisionId: Number(row.decision_id),
    event: 'execution_started',
    actorType: 'user',
    actorId: actorUserId || null,
    metadata: { executor: definition.executorKey, policy },
  });

  try {
    const decision = await db.get(
      'SELECT event_id, priority, reason FROM dot_decisions WHERE id = ? AND empresa_id = ? LIMIT 1',
      [Number(row.decision_id), empresaId],
    );
    if (!decision) throw new Error('Decisão vinculada não encontrada durante a execução.');

    const internal = await executeDotInternalAction({
      empresaId,
      actionId,
      decisionId: Number(row.decision_id),
      action: String(row.action),
      eventId: decision.event_id ?? null,
      priority: decision.priority ?? null,
      reason: decision.reason ?? null,
    });
    const executedAt = new Date().toISOString();
    const finished = await db.run(
      "UPDATE dot_action_queue SET status = 'executed', executed_at = ? WHERE id = ? AND empresa_id = ? AND status = 'executing'",
      [executedAt, actionId, empresaId],
    );
    if (!finished || finished.changes !== 1) {
      throw new Error('Executor perdeu a posse da ação durante a execução.');
    }

    await recordDotActionAudit({
      empresaId,
      actionId,
      decisionId: Number(row.decision_id),
      event: 'executed',
      actorType: 'user',
      actorId: actorUserId || null,
      metadata: {
        executor: definition.executorKey,
        simulated: false,
        externalSideEffect: false,
        internalCaseId: internal.caseId,
        internalStatus: internal.status,
        nextStep: internal.nextStep,
        created: internal.created,
      },
    });

    await createDotFollowUp(empresaId, Number(row.decision_id), actionId, 24);

    return {
      ok: true,
      id: actionId,
      status: 'executed',
      simulated: false,
      executor: definition.executorKey,
      startedAt,
      executedAt,
      reason: `Caso interno ${internal.created ? 'criado' : 'atualizado'} (#${internal.caseId}) para acompanhamento.`
    };

  } catch (error: any) {
    const reason = String(error?.message || error);
    await db.run(
      "UPDATE dot_action_queue SET status = 'failed', error = ? WHERE id = ? AND empresa_id = ? AND status = 'executing'",
      [reason, actionId, empresaId],
    );
    await recordDotActionAudit({
      empresaId,
      actionId,
      decisionId: Number(row.decision_id),
      event: 'failed',
      actorType: 'user',
      actorId: actorUserId || null,
      metadata: { executor: definition.executorKey, error: reason },
    });
    return { ok: false, id: actionId, status: 'failed', simulated: true, executor: definition.executorKey, startedAt, reason };
  }
}
