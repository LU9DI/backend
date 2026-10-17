import { getDb } from '../lib/db.js';
import { advanceMission, ensureMissionTables, withMissionLock, type DotAgentMission } from './dotAgentMissions.js';
import { touchDotAgentGoal } from './dotAgent.js';
import { loadDotContextForMessage } from './dotContext.js';
import { resolveDotComplaint } from './dotResolve.js';
import { runDotMonitor } from './dotMonitor.js';
import { withDotLock } from './dotCoordination.js';

/**
 * Runner de missões do agente Dot.
 *
 * Executa a etapa atual de uma missão, uma por vez, sempre escopada por
 * `empresa_id`. Regras que o runner respeita:
 *
 *  - Idempotência: uma etapa concluída nunca é reexecutada; a missão avança de
 *    forma monotônica e cada chamada ou avança ou bloqueia.
 *  - Aprovação separada da execução: a etapa `approval` é uma barreira real.
 *    O runner nunca executa a ação — apenas verifica se ela foi aprovada.
 *  - Tratamento de falhas: falhas incrementam o contador de tentativas da etapa
 *    e, após o limite, a missão é pausada em vez de repetir para sempre.
 *  - Nada aqui chama IA: as etapas são determinísticas e usam apenas dados
 *    persistidos. Preparar uma ação é diferente de executá-la.
 */

const MAX_STEP_ATTEMPTS = Math.max(1, Number(process.env.DOT_MISSION_MAX_STEP_ATTEMPTS || 3));

type MissionRow = {
  id: number | string;
  goal_id: number | string;
  empresa_id: string;
  title: string;
  status: string;
  current_step: number | string;
  total_steps: number | string;
  approval_action_id?: number | string | null;
  created_at: string;
  updated_at: string;
};

type StepRow = {
  id: number | string;
  mission_id: number | string;
  type: string;
  status: string;
  title: string;
  output: string | null;
  attempts?: number | string | null;
};

export type DotMissionStepInfo = {
  id: number;
  type: string;
  title: string;
  status: string;
  attempts: number;
};

export type DotMissionStepResult = {
  blocked: boolean;
  mission: DotAgentMission | null;
  step: DotMissionStepInfo | null;
  output: string | null;
  executed: boolean;
  reason: string;
};

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toMission(row: MissionRow): DotAgentMission {
  return {
    id: num(row.id),
    goal_id: num(row.goal_id),
    empresa_id: String(row.empresa_id),
    title: String(row.title),
    status: String(row.status) as DotAgentMission['status'],
    current_step: num(row.current_step),
    total_steps: num(row.total_steps || 6),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

async function loadMission(empresaId: string, missionId: number): Promise<DotAgentMission | null> {
  const row = ((await getDb().get(
    'SELECT * FROM dot_agent_missions WHERE id = ? AND empresa_id = ?',
    [missionId, empresaId],
  )) ?? null) as MissionRow | null;
  return row ? toMission(row) : null;
}

async function loadGoalTitle(empresaId: string, goalId: number): Promise<string> {
  if (!Number.isFinite(goalId) || goalId <= 0) return 'objetivo do agente';
  try {
    const row = await getDb().get(
      'SELECT title FROM dot_agent_goals WHERE id = ? AND empresa_id = ?',
      [goalId, empresaId],
    );
    const title = row ? String(row.title || '').trim() : '';
    return title || 'objetivo do agente';
  } catch {
    return 'objetivo do agente';
  }
}

function progressFor(mission: DotAgentMission | null): number {
  if (!mission || mission.total_steps <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((mission.current_step / mission.total_steps) * 100)));
}

function firstPreparedAction(monitor: { prepared_actions?: unknown[] }): { id: number; action: string } | null {
  const list = Array.isArray(monitor?.prepared_actions) ? monitor.prepared_actions : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = num(record.id);
    if (id > 0) return { id, action: String(record.action || '') };
  }
  return null;
}

function describeNoPreparation(monitor: {
  skipped?: boolean;
  reason?: string;
  events?: unknown[];
  policy?: { prepareAction?: boolean };
}): string {
  if (monitor?.skipped) {
    return `Nenhuma ação foi preparada: ${monitor.reason || 'monitoramento desativado pelas preferências'}.`;
  }
  if (!monitor?.policy?.prepareAction) {
    return 'Nenhuma ação foi preparada: a política do Dot não autoriza preparar ações automaticamente nas preferências atuais.';
  }
  if (!Array.isArray(monitor?.events) || monitor.events.length === 0) {
    return 'Nenhuma ação foi preparada: o monitoramento não encontrou sinal novo nas avaliações desta empresa.';
  }
  return 'Nenhuma ação foi preparada nesta rodada: os sinais encontrados não geraram uma decisão com opção executável.';
}

async function executeStep(
  empresaId: string,
  mission: MissionRow,
  step: StepRow,
  goalTitle: string,
): Promise<{ blocked: true; reason: string } | { blocked: false; output: string }> {
  const db = getDb();
  const missionId = num(mission.id);
  const approvalActionId = num(mission.approval_action_id);

  switch (String(step.type)) {
    case 'observe': {
      const context = await loadDotContextForMessage(empresaId, goalTitle);
      const snapshot = context.snapshot;
      return {
        blocked: false,
        output: snapshot.total > 0
          ? `Contexto observado: ${snapshot.total} avaliações reais, nota média ${snapshot.average}/5, ${snapshot.critical} críticas e ${snapshot.pending} aguardando resposta.`
          : 'Contexto observado: ainda não há avaliações reais registradas para esta empresa.',
      };
    }

    case 'investigate': {
      const resolved = await resolveDotComplaint(empresaId, goalTitle);
      return {
        blocked: false,
        output: `Investigação do objetivo: verificação "${resolved.verification_status}" com confiança ${resolved.confidence}. ${resolved.facts.map((fact) => fact.fact).join(' ')}`,
      };
    }

    case 'recommend': {
      const resolved = await resolveDotComplaint(empresaId, goalTitle);
      const options = resolved.options.map((option) => `${option.title} (${option.action})`).join(' ou ');
      return {
        blocked: false,
        output: `Recomendação registrada com ${resolved.evidence.length} evidência(s). Caminhos possíveis: ${options}. A decisão continua com o responsável.`,
      };
    }

    case 'prepare': {
      if (approvalActionId) {
        return { blocked: false, output: `A ação #${approvalActionId} já estava preparada e aguarda aprovação explícita.` };
      }
      const monitor = await runDotMonitor(empresaId);
      const prepared = firstPreparedAction(monitor);
      if (!prepared) {
        return { blocked: false, output: describeNoPreparation(monitor) };
      }
      await db.run(
        'UPDATE dot_agent_missions SET approval_action_id = ?, updated_at = ? WHERE id = ? AND empresa_id = ?',
        [prepared.id, new Date().toISOString(), missionId, empresaId],
      );
      return {
        blocked: false,
        output: `Ação #${prepared.id} (${prepared.action}) preparada. Ela só será executada após aprovação explícita do responsável.`,
      };
    }

    case 'approval': {
      if (!approvalActionId) {
        return { blocked: false, output: 'Nenhuma ação pendente de aprovação nesta missão.' };
      }
      const action = await db.get(
        'SELECT id, status, action FROM dot_action_queue WHERE id = ? AND empresa_id = ?',
        [approvalActionId, empresaId],
      );
      if (!action) throw new Error('A ação vinculada à aprovação não foi encontrada.');
      const status = String(action.status);
      if (status === 'prepared') {
        // Barreira de segurança: sem aprovação explícita a missão não avança.
        return { blocked: true, reason: `A ação #${approvalActionId} aguarda aprovação explícita do responsável.` };
      }
      return { blocked: false, output: `Ação #${approvalActionId} está com status "${status}".` };
    }

    case 'result': {
      if (!approvalActionId) {
        return { blocked: false, output: 'A missão não gerou ação executável; resultado registrado sem execução externa.' };
      }
      const action = await db.get(
        'SELECT id, status, error FROM dot_action_queue WHERE id = ? AND empresa_id = ?',
        [approvalActionId, empresaId],
      );
      if (!action) throw new Error('A ação vinculada ao resultado não foi encontrada.');
      const status = String(action.status);
      const detail = action.error ? ` Motivo registrado: ${String(action.error)}.` : '';
      return {
        blocked: false,
        output: `Resultado da ação #${approvalActionId}: status "${status}".${detail}`,
      };
    }

    default:
      return { blocked: false, output: `Etapa "${String(step.type)}" não exige trabalho automatizado.` };
  }
}

export async function runCurrentDotMissionStep(
  empresaId: string,
  missionId: number,
): Promise<DotMissionStepResult | null> {
  const tenant = String(empresaId || '').trim();
  const id = Math.trunc(Number(missionId));
  if (!tenant || !Number.isFinite(id) || id <= 0) return null;
  // Trava em memória (mesmo processo) + claim durável no banco (entre
  // instâncias): a etapa de uma missão é executada por no máximo uma
  // instância por vez. A segunda instância aguarda o lock por até 30s e, se
  // não conseguir, devolve `blocked` — nunca executa a mesma etapa em dobro.
  const lock = await withDotLock(
    `mission:${tenant}:${id}`,
    2 * 60_000,
    () => withMissionLock(tenant, id, () => runCurrentDotMissionStepUnlocked(tenant, id)),
    { waitMs: 30_000 },
  );
  if (!lock.acquired) {
    return {
      blocked: true,
      mission: null,
      step: null,
      output: null,
      executed: false,
      reason: 'Outra instância está executando esta missão no momento; tente novamente em instantes.',
    };
  }
  return lock.result;
}

async function runCurrentDotMissionStepUnlocked(
  tenant: string,
  id: number,
): Promise<DotMissionStepResult | null> {
  await ensureMissionTables();
  const db = getDb();
  const mission = ((await db.get(
    'SELECT * FROM dot_agent_missions WHERE id = ? AND empresa_id = ?',
    [id, tenant],
  )) ?? null) as MissionRow | null;
  if (!mission) return null;

  const missionState = toMission(mission);
  if (missionState.status === 'completed') {
    return { blocked: true, mission: missionState, step: null, output: null, executed: false, reason: 'Missão já concluída.' };
  }
  if (missionState.status === 'paused') {
    return { blocked: true, mission: missionState, step: null, output: null, executed: false, reason: 'Missão pausada.' };
  }
  if (missionState.current_step >= missionState.total_steps) {
    return { blocked: true, mission: missionState, step: null, output: null, executed: false, reason: 'Missão sem etapas pendentes.' };
  }

  const step = ((await db.get(
    'SELECT id, mission_id, type, status, title, output, attempts FROM dot_agent_mission_steps WHERE mission_id = ? AND empresa_id = ? ORDER BY id ASC LIMIT 1 OFFSET ?',
    [id, tenant, missionState.current_step],
  )) ?? null) as StepRow | null;
  if (!step) {
    return { blocked: true, mission: missionState, step: null, output: null, executed: false, reason: 'Etapa atual da missão não encontrada.' };
  }

  const stepInfo: DotMissionStepInfo = {
    id: num(step.id),
    type: String(step.type),
    title: String(step.title),
    status: String(step.status),
    attempts: num(step.attempts),
  };

  // Recuperação de estado inconsistente: a etapa já está concluída mas a missão
  // não avançou. Avançar é seguro e não reexecuta trabalho.
  if (stepInfo.status === 'completed') {
    const advanced = await advanceMission(tenant, id);
    return {
      blocked: false,
      mission: advanced,
      step: stepInfo,
      output: step.output ?? null,
      executed: false,
      reason: 'Etapa já estava concluída; a missão foi avançada.',
    };
  }

  const goalTitle = await loadGoalTitle(tenant, missionState.goal_id);

  try {
    const outcome = await executeStep(tenant, mission, step, goalTitle);

    if (outcome.blocked) {
      return { blocked: true, mission: missionState, step: stepInfo, output: null, executed: false, reason: outcome.reason };
    }

    const advanced = await advanceMission(tenant, id, outcome.output);
    await db.run(
      'UPDATE dot_agent_mission_steps SET attempts = 0 WHERE id = ? AND empresa_id = ?',
      [stepInfo.id, tenant],
    );
    await touchDotAgentGoal(tenant, missionState.goal_id, progressFor(advanced));

    return {
      blocked: false,
      mission: advanced,
      step: stepInfo,
      output: outcome.output,
      executed: true,
      reason: 'Etapa executada e registrada.',
    };
  } catch (error) {
    const message = errorMessage(error).slice(0, 500);
    const attempts = stepInfo.attempts + 1;

    await db.run(
      'UPDATE dot_agent_mission_steps SET attempts = ?, output = ? WHERE id = ? AND empresa_id = ?',
      [attempts, `Falha ao executar a etapa (tentativa ${attempts}): ${message}`, stepInfo.id, tenant],
    );

    if (attempts >= MAX_STEP_ATTEMPTS) {
      await db.run(
        "UPDATE dot_agent_missions SET status = 'paused', updated_at = ? WHERE id = ? AND empresa_id = ?",
        [new Date().toISOString(), id, tenant],
      );
      const paused = await loadMission(tenant, id);
      return {
        blocked: true,
        mission: paused,
        step: { ...stepInfo, attempts },
        output: null,
        executed: false,
        reason: `Missão pausada após ${attempts} falhas na etapa "${stepInfo.type}": ${message}`,
      };
    }

    return {
      blocked: true,
      mission: missionState,
      step: { ...stepInfo, attempts },
      output: null,
      executed: false,
      reason: `Falha temporária na etapa "${stepInfo.type}" (tentativa ${attempts}): ${message}`,
    };
  }
}

/**
 * Avanço manual (sem executar trabalho) usado pela rota `/advance`. Continua
 * sujeito à mesma barreira de aprovação e à trava por missão do runner.
 */
export async function advanceMissionManually(
  empresaId: string,
  missionId: number,
  output?: string,
): Promise<DotAgentMission | null> {
  const tenant = String(empresaId || '').trim();
  const id = Math.trunc(Number(missionId));
  if (!tenant || !Number.isFinite(id) || id <= 0) return null;
  await ensureMissionTables();
  const runLocked = () => withMissionLock(tenant, id, () => advanceMission(tenant, id, output));
  // Claim durável entre instâncias (ver dotCoordination): dois avanços
  // simultâneos da mesma missão eram capazes de marcar etapas em dobro.
  const lock = await withDotLock(`mission:${tenant}:${id}`, 2 * 60_000, runLocked, { waitMs: 15_000 });
  if (!lock.acquired) {
    throw new Error('Outra instância está processando esta missão no momento; tente novamente em instantes.');
  }
  return lock.result;
}

/**
 * Retoma uma missão pausada. Reinicia apenas o contador de tentativas da etapa
 * atual — o histórico de falhas permanece registrado no output da etapa até
 * ser substituído por uma execução bem-sucedida. Não reexecuta nem duplica
 * ações já preparadas.
 */
export async function resumePausedMission(
  empresaId: string,
  missionId: number,
): Promise<{ mission: DotAgentMission; resumed: boolean; reason: string } | null> {
  const tenant = String(empresaId || '').trim();
  const id = Math.trunc(Number(missionId));
  if (!tenant || !Number.isFinite(id) || id <= 0) return null;

  await ensureMissionTables();
  const runLocked = () => withMissionLock(tenant, id, async () => {
    const db = getDb();
    const mission = ((await db.get(
      'SELECT * FROM dot_agent_missions WHERE id = ? AND empresa_id = ?',
      [id, tenant],
    )) ?? null) as MissionRow | null;
    if (!mission) return null;

    const missionState = toMission(mission);
    if (missionState.status !== 'paused') {
      return { mission: missionState, resumed: false, reason: 'A missão não está pausada.' };
    }

    const currentStep = ((await db.get(
      'SELECT id, mission_id, type, status, title, output, attempts FROM dot_agent_mission_steps WHERE mission_id = ? AND empresa_id = ? ORDER BY id ASC LIMIT 1 OFFSET ?',
      [id, tenant, missionState.current_step],
    )) ?? null) as StepRow | null;

    const now = new Date().toISOString();
    if (currentStep?.id) {
      await db.run(
        'UPDATE dot_agent_mission_steps SET attempts = 0 WHERE id = ? AND empresa_id = ?',
        [num(currentStep.id), tenant],
      );
    }

    const nextStatus: DotAgentMission['status'] = missionState.current_step >= missionState.total_steps
      ? 'completed'
      : String(currentStep?.type || '') === 'approval'
        ? 'waiting_approval'
        : 'working';

    await db.run(
      "UPDATE dot_agent_missions SET status = ?, updated_at = ? WHERE id = ? AND empresa_id = ? AND status = 'paused'",
      [nextStatus, now, id, tenant],
    );

    const updated = await loadMission(tenant, id);
    return {
      mission: updated || missionState,
      resumed: true,
      reason: nextStatus === 'waiting_approval'
        ? 'Missão retomada; a etapa atual aguarda aprovação explícita.'
        : 'Missão retomada.',
    };
  });
  // Claim durável entre instâncias: retomar em duas instâncias ao mesmo
  // tempo podia zerar tentativas e mudar o status em dobro.
  const lock = await withDotLock(`mission:${tenant}:${id}`, 2 * 60_000, runLocked, { waitMs: 15_000 });
  if (!lock.acquired) {
    throw new Error('Outra instância está processando esta missão no momento; tente novamente em instantes.');
  }
  return lock.result;
}

/**
 * Continua a missão vinculada quando a ação aprovada dela foi executada pelo
 * gateway (`POST /api/dot/actions/:id/run`). Avançar aqui exige que a
 * aprovação registrada pertença à própria missão; executar não é aprovar.
 */
export async function resumeMissionAfterApprovedExecution(
  empresaId: string,
  actionId: number,
  output?: string,
): Promise<DotAgentMission | null> {
  const tenant = String(empresaId || '').trim();
  const id = Math.trunc(Number(actionId));
  if (!tenant || !Number.isFinite(id) || id <= 0) return null;

  await ensureMissionTables();
  const db = getDb();
  const mission = ((await db.get(
    "SELECT * FROM dot_agent_missions WHERE empresa_id = ? AND status = 'waiting_approval' AND approval_action_id = ? ORDER BY id DESC LIMIT 1",
    [tenant, id],
  )) ?? null) as MissionRow | null;
  if (!mission) return null;

  const missionId = num(mission.id);
  const runLocked = () => withMissionLock(tenant, missionId, async () => {
    // Reconfere dentro da trava: se a missão já saiu de `waiting_approval`
    // (por exemplo, o responsável avançou a etapa), não há o que continuar.
    const fresh = await loadMission(tenant, missionId);
    if (!fresh || fresh.status !== 'waiting_approval') return fresh;

    const advanced = await advanceMission(tenant, missionId, output);
    if (!advanced) return null;
    if (advanced.status === 'working') {
      const continued = await runCurrentDotMissionStepUnlocked(tenant, missionId);
      return continued?.mission || advanced;
    }
    return advanced;
  });
  // A execução no gateway já é reivindicada de forma atômica; este claim
  // cobre a retomada da missão para que duas instâncias não avancem juntas.
  const lock = await withDotLock(`mission:${tenant}:${missionId}`, 2 * 60_000, runLocked, { waitMs: 15_000 });
  if (!lock.acquired) {
    throw new Error('Outra instância está processando esta missão no momento; tente novamente em instantes.');
  }
  return lock.result;
}
