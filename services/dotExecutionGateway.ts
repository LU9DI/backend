import { getDb, withDbTransaction } from '../lib/db.js';
import { dotActionRequiresApproval, getDotActionDefinition } from './dotActionRegistry.js';
import { evaluateDotPolicy, type DotRisk } from './dotPolicy.js';
import { getDotPreferences } from './dotPreferences.js';
import { ensureDotActionAuditSchema, recordDotActionAudit } from './dotActionAudit.js';
import { createDotFollowUp, ensureDotFollowUpSchema } from './dotFollowUp.js';
import { requireDotAccess, type DotAccessResource } from './dotAccessControl.js';
import { ensureDotInternalActionSchema, executeDotInternalAction } from './dotInternalExecutors.js';
import { ensureDotActionSchema } from './dotActionQueue.js';
import { dotActorAuditColumns, resolveDotActor, type DotActor } from './dotActor.js';

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
  actor: DotActor | null | undefined,
): Promise<DotExecutionResult> {
  // Contrato explícito: ator de usuário com ID, ou ator interno autorizado.
  // Nunca inferimos `dot` pela ausência de identidade; ausência é rejeitada.
  const resolvedActor = resolveDotActor(actor);
  const actorAudit = dotActorAuditColumns(resolvedActor);
  const actorMetadata = resolvedActor.type === 'dot' ? { actor_source: resolvedActor.source } : {};

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
    await requireDotAccess(empresaId, permissionResource, 'execute', resolvedActor.type === 'user' ? resolvedActor.userId : null, { actionId, action: definition.action, executor: definition.executorKey });
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
  let phase = 'precheck';

  try {
    // Verificações de schema (sem DDL) ANTES de abrir a transação. DDL não
    // pode rodar no caminho de execução; as tabelas vêm de runCentralMigrations.
    await ensureDotActionSchema();
    await ensureDotActionAuditSchema();
    await ensureDotInternalActionSchema();
    await ensureDotFollowUpSchema();

    const outcome = await withDbTransaction(async (tx) => {
      // Relê dentro da transação: o estado pode ter mudado desde o precheck.
      const current = await tx.get(
        `SELECT a.*, d.status AS decision_status, d.requires_approval,
                d.event_id, d.priority, d.reason AS decision_reason
           FROM dot_action_queue a
           JOIN dot_decisions d ON d.id = a.decision_id AND d.empresa_id = a.empresa_id
          WHERE a.id = ? AND a.empresa_id = ? AND a.status = 'approved' LIMIT 1`,
        [actionId, empresaId],
      );
      if (!current) return { kind: 'not_found' as const };
      if (String(current.decision_status) !== 'approved' || Number(current.requires_approval) !== 1) {
        return { kind: 'invalid' as const };
      }

      phase = 'claim';
      const claimed = await tx.run(
        "UPDATE dot_action_queue SET status = 'executing', error = NULL WHERE id = ? AND empresa_id = ? AND status = 'approved'",
        [actionId, empresaId],
      );
      if (!claimed || claimed.changes !== 1) return { kind: 'conflict' as const };

      phase = 'execution_started';
      await recordDotActionAudit({
        empresaId,
        actionId,
        decisionId: Number(current.decision_id),
        event: 'execution_started',
        actorType: actorAudit.actorType,
        actorId: actorAudit.actorId,
        metadata: { executor: definition.executorKey, policy, ...actorMetadata },
      }, tx);

      const decision = await tx.get(
        'SELECT event_id, priority, reason FROM dot_decisions WHERE id = ? AND empresa_id = ? LIMIT 1',
        [Number(current.decision_id), empresaId],
      );
      if (!decision) throw new Error('Decisão vinculada não encontrada durante a execução.');

      phase = 'internal_action';
      const internal = await executeDotInternalAction({
        empresaId,
        actionId,
        decisionId: Number(current.decision_id),
        action: String(current.action),
        eventId: decision.event_id ?? null,
        priority: decision.priority ?? null,
        reason: decision.reason ?? null,
      }, tx);

      phase = 'follow_up';
      await createDotFollowUp(empresaId, Number(current.decision_id), actionId, 24, tx);

      phase = 'executed';
      const executedAt = new Date().toISOString();
      const finished = await tx.run(
        "UPDATE dot_action_queue SET status = 'executed', executed_at = ? WHERE id = ? AND empresa_id = ? AND status = 'executing'",
        [executedAt, actionId, empresaId],
      );
      if (!finished || finished.changes !== 1) {
        throw new Error('Executor perdeu a posse da ação durante a execução.');
      }

      await recordDotActionAudit({
        empresaId,
        actionId,
        decisionId: Number(current.decision_id),
        event: 'executed',
        actorType: actorAudit.actorType,
        actorId: actorAudit.actorId,
        metadata: {
          executor: definition.executorKey,
          simulated: false,
          externalSideEffect: false,
          internalCaseId: internal.caseId,
          internalStatus: internal.status,
          nextStep: internal.nextStep,
          created: internal.created,
          ...actorMetadata,
        },
      }, tx);

      return { kind: 'ok' as const, internal, executedAt };
    });

    if (outcome.kind === 'not_found') {
      return { ok: false, id: actionId, status: 'approved', simulated: true, executor: definition.executorKey, startedAt, reason: 'Ação não encontrada ou não aprovada.' };
    }
    if (outcome.kind === 'invalid') {
      return { ok: false, id: actionId, status: String(row.status), simulated: true, executor: definition.executorKey, startedAt, reason: 'A decisão vinculada não está aprovada para execução.' };
    }
    if (outcome.kind === 'conflict') {
      return { ok: false, id: actionId, status: 'approved', simulated: true, executor: definition.executorKey, startedAt, reason: 'Ação já está sendo processada ou mudou de estado.' };
    }

    return {
      ok: true,
      id: actionId,
      status: 'executed',
      simulated: false,
      executor: definition.executorKey,
      startedAt,
      executedAt: outcome.executedAt,
      reason: `Caso interno ${outcome.internal.created ? 'criado' : 'atualizado'} (#${outcome.internal.caseId}) para acompanhamento.`,
    };
  } catch (error: any) {
    // A transação revertida desfaz claim, execution_started, caso, follow-up e
    // status. A ação continua `approved` e retentável. A falha é auditada fora
    // da transação, sem mascarar a exceção original.
    const reason = String(error?.message || error);
    try {
      await recordDotActionAudit({
        empresaId,
        actionId,
        decisionId: Number(row.decision_id),
        event: 'failed',
        actorType: actorAudit.actorType,
        actorId: actorAudit.actorId,
        metadata: { executor: definition.executorKey, error: reason, phase, rolled_back: true, ...actorMetadata },
      });
    } catch (auditError: any) {
      console.error('[dot] failed audit write failed:', String(auditError?.message || auditError).slice(0, 300));
    }
    return { ok: false, id: actionId, status: 'approved', simulated: true, executor: definition.executorKey, startedAt, reason };
  }
}
