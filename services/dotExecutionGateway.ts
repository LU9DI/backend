import { getDb } from '../lib/db.js';
import { dotActionRequiresApproval, getDotActionDefinition } from './dotActionRegistry.js';
import { evaluateDotPolicy, type DotRisk } from './dotPolicy.js';
import { getDotPreferences } from './dotPreferences.js';
import { recordDotActionAudit } from './dotActionAudit.js';
import { createDotFollowUp } from './dotFollowUp.js';

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
    actorType: 'system',
    metadata: { executor: definition.executorKey, policy },
  });

  try {
    // Execução interna real: o Dot não envia nada para fora, mas transforma a
    // aprovação em um caso operacional persistido e auditável.
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
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_dot_internal_cases_action ON dot_internal_cases(empresa_id, action_id)');

    const existingCase = await db.get(
      'SELECT * FROM dot_internal_cases WHERE empresa_id = ? AND action_id = ? LIMIT 1',
      [empresaId, actionId],
    );

    let internalCase = existingCase;
    if (!internalCase) {
      const decision = await db.get(
        'SELECT event_id, priority, reason FROM dot_decisions WHERE id = ? AND empresa_id = ? LIMIT 1',
        [Number(row.decision_id), empresaId],
      );
      if (!decision) throw new Error('Decisão vinculada não encontrada durante a execução.');

      const mapping: Record<string, { status: string; nextStep: string }> = {
        priorizar_e_resolver: {
          status: 'prioritized',
          nextStep: 'Validar a evidência e registrar a resolução antes de qualquer contato externo.',
        },
        escalar_responsavel: {
          status: 'escalated',
          nextStep: 'Responsável deve revisar o caso e definir a tratativa.',
        },
        corrigir_e_acompanhar: {
          status: 'monitoring',
          nextStep: 'Aplicar a correção interna e aguardar o acompanhamento do Dot.',
        },
      };
      const outcome = mapping[String(row.action)] || {
        status: 'open',
        nextStep: 'Revisar o caso no painel do Dot.',
      };

      const result = await db.run(
        'INSERT INTO dot_internal_cases (empresa_id,decision_id,action_id,event_id,action,status,priority,summary,next_step,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id',
        [
          empresaId,
          Number(row.decision_id),
          actionId,
          decision.event_id ?? null,
          String(row.action),
          outcome.status,
          String(decision.priority || 'media'),
          String(decision.reason || 'Caso criado pelo Dot.').slice(0, 4000),
          outcome.nextStep,
          startedAt,
          startedAt,
        ],
      );
      internalCase = await db.get(
        'SELECT * FROM dot_internal_cases WHERE id = ? AND empresa_id = ? LIMIT 1',
        [result.lastID, empresaId],
      );
    }

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
      actorType: 'system',
      metadata: {
        executor: definition.executorKey,
        simulated: false,
        externalSideEffect: false,
        internalCaseId: internalCase?.id ?? null,
        internalStatus: internalCase?.status ?? null,
        nextStep: internalCase?.next_step ?? null,
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
      reason: internalCase
        ? `Caso interno criado/atualizado (#${internalCase.id}) para acompanhamento.`
        : 'Caso interno criado para acompanhamento.',
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
      actorType: 'system',
      metadata: { executor: definition.executorKey, error: reason },
    });
    return { ok: false, id: actionId, status: 'failed', simulated: true, executor: definition.executorKey, startedAt, reason };
  }
}
