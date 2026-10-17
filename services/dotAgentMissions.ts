import { getDb } from '../lib/db.js';
import { ensureDotAgentSchema } from './dotAgent.js';

export type DotAgentMissionApprovalAction = {
  id: number;
  status: string;
  action: string;
};

export type DotAgentMission = {
  id: number;
  goal_id: number;
  empresa_id: string;
  title: string;
  status: 'planned' | 'working' | 'waiting_approval' | 'completed' | 'paused';
  current_step: number;
  total_steps: number;
  created_at: string;
  updated_at: string;
  approval_action_id?: number | null;
  approval_action?: DotAgentMissionApprovalAction | null;
};

export type DotAgentMissionStep = {
  id: number;
  mission_id: number;
  type: 'observe' | 'investigate' | 'recommend' | 'prepare' | 'approval' | 'result';
  status: 'pending' | 'working' | 'completed' | 'waiting_approval';
  title: string;
  output: string | null;
  created_at: string;
  completed_at: string | null;
};

export async function ensureMissionTables() {
  const db = getDb();
  await db.exec(`CREATE TABLE IF NOT EXISTS dot_agent_missions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL,
    empresa_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned',
    current_step INTEGER NOT NULL DEFAULT 0,
    total_steps INTEGER NOT NULL DEFAULT 3,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_dot_agent_missions_empresa
    ON dot_agent_missions (empresa_id, status, updated_at)`);
  const missionColumns = await db.all('PRAGMA table_info(dot_agent_missions)');
  if (!(missionColumns || []).some((column: any) => column.name === 'approval_action_id')) {
    await db.exec('ALTER TABLE dot_agent_missions ADD COLUMN approval_action_id INTEGER');
  }
  await db.exec(`CREATE TABLE IF NOT EXISTS dot_agent_mission_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL,
    empresa_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    title TEXT NOT NULL,
    output TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  )`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_dot_agent_mission_steps_mission
    ON dot_agent_mission_steps (empresa_id, mission_id, id)`);
  const stepColumns = await db.all('PRAGMA table_info(dot_agent_mission_steps)');
  if (!(stepColumns || []).some((column: { name?: string }) => column.name === 'attempts')) {
    // Contador de tentativas por etapa: permite interromper uma etapa que falha
    // repetidamente em vez de reprocessá-la para sempre.
    await db.exec('ALTER TABLE dot_agent_mission_steps ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  }
}

function row(row: any): DotAgentMission {
  return {
    id: Number(row.id), goal_id: Number(row.goal_id), empresa_id: String(row.empresa_id),
    title: String(row.title), status: String(row.status) as DotAgentMission['status'],
    current_step: Number(row.current_step || 0), total_steps: Number(row.total_steps || 3),
    created_at: String(row.created_at), updated_at: String(row.updated_at),
    approval_action_id: row.approval_action_id === null || row.approval_action_id === undefined
      ? null
      : Number(row.approval_action_id),
  };
}

/**
 * Serializa, em memória, as transições de uma mesma missão (executar etapa,
 * avançar, retomar). O runner executa trabalho assíncrono entre a leitura e a
 * gravação do estado; sem esta trava duas chamadas simultâneas poderiam
 * executar a mesma etapa duas vezes. O escopo é a missão da empresa — nunca
 * cruza tenants.
 */
const missionLocks = new Map<string, Promise<void>>();

export async function withMissionLock<T>(empresaId: string, missionId: number, work: () => Promise<T>): Promise<T> {
  const key = `${String(empresaId || '').trim()}:${Math.trunc(Number(missionId))}`;
  const previous = missionLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  missionLocks.set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (missionLocks.get(key) === current) missionLocks.delete(key);
  }
}

async function attachApprovalActions(empresaId: string, missions: DotAgentMission[]) {
  const ids = missions
    .map((mission) => Number(mission.approval_action_id || 0))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) {
    return missions.map((mission) => ({ ...mission, approval_action: null }));
  }
  const placeholders = ids.map(() => '?').join(',');
  const rows = await getDb().all(
    `SELECT id, status, action FROM dot_action_queue WHERE empresa_id = ? AND id IN (${placeholders})`,
    [empresaId, ...ids],
  );
  const byId = new Map<number, DotAgentMissionApprovalAction>();
  for (const actionRow of rows || []) {
    byId.set(Number(actionRow.id), {
      id: Number(actionRow.id),
      status: String(actionRow.status),
      action: String(actionRow.action),
    });
  }
  return missions.map((mission) => ({
    ...mission,
    approval_action: byId.get(Number(mission.approval_action_id || 0)) || null,
  }));
}

export async function listDotAgentMissions(empresaId: string) {
  await ensureMissionTables();
  const db = getDb();
  const rows = await db.all(
    'SELECT * FROM dot_agent_missions WHERE empresa_id=? ORDER BY updated_at DESC LIMIT 20',
    [empresaId],
  );
  return attachApprovalActions(empresaId, (rows || []).map(row));
}

export async function createMissionForGoal(empresaId: string, goalId: number, title: string) {
  await ensureMissionTables();
  await ensureDotAgentSchema();
  const db = getDb();
  const goal = await db.get('SELECT id FROM dot_agent_goals WHERE id=? AND empresa_id=?', [goalId, empresaId]);
  if (!goal) return null;
  const existing = await db.get(
    "SELECT * FROM dot_agent_missions WHERE goal_id=? AND empresa_id=? AND status IN ('planned','working','waiting_approval') ORDER BY id DESC LIMIT 1",
    [goalId, empresaId],
  );
  if (existing) return row(existing);

  const now = new Date().toISOString();
  const result = (await db.run(
    'INSERT INTO dot_agent_missions (goal_id,empresa_id,title,status,current_step,total_steps,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) RETURNING id',
    [goalId, empresaId, title.slice(0, 180), 'planned', 0, 6, now, now],
  )) as unknown as { changes: number; lastID?: number | bigint; lastInsertRowid?: number | bigint; id?: number | bigint };
  const id = Number(result?.lastID ?? result?.lastInsertRowid ?? result?.id);
  const stepTitles = [
    ['observe', 'Observar o contexto disponível'],
    ['investigate', 'Investigar o que está impedindo o objetivo'],
    ['recommend', 'Recomendar o próximo caminho'],
    ['prepare', 'Preparar o trabalho necessário'],
    ['approval', 'Aguardar aprovação quando necessário'],
    ['result', 'Acompanhar o resultado'],
  ] as const;
  for (const [type, stepTitle] of stepTitles) {
    await db.run(
      'INSERT INTO dot_agent_mission_steps (mission_id,empresa_id,type,status,title,created_at) VALUES (?,?,?,?,?,?)',
      [id, empresaId, type, 'pending', stepTitle, now],
    );
  }
  const created = await db.get('SELECT * FROM dot_agent_missions WHERE id=? AND empresa_id=?', [id, empresaId]);
  return created ? row(created) : null;
}

export async function listDotAgentMissionSteps(empresaId: string, missionId: number) {
  await ensureMissionTables();
  const db = getDb();
  const rows = await db.all(
    'SELECT id,mission_id,type,status,title,output,created_at,completed_at FROM dot_agent_mission_steps WHERE mission_id=? AND empresa_id=? ORDER BY id ASC',
    [missionId, empresaId],
  );
  return rows || [];
}

export async function advanceMission(empresaId: string, id: number, output?: string) {
  await ensureMissionTables();
  const db = getDb();
  const mission = await db.get('SELECT * FROM dot_agent_missions WHERE id=? AND empresa_id=?', [id, empresaId]);
  if (!mission) return null;

  const missionStatus = String(mission.status || '');
  // Concluída não avança de novo; pausada só volta a andar por retomada explícita.
  if (missionStatus === 'completed') return row(mission);
  if (missionStatus === 'paused') {
    throw new Error('Missão pausada: retome a missão explicitamente antes de avançar.');
  }

  const current = Number(mission.current_step || 0);
  const total = Number(mission.total_steps || 6);
  const now = new Date().toISOString();

  const currentStep = await db.get(
    'SELECT id,type,status FROM dot_agent_mission_steps WHERE mission_id=? AND empresa_id=? ORDER BY id ASC LIMIT 1 OFFSET ?',
    [id, empresaId, current],
  );

  // A etapa de aprovação é uma barreira de segurança, não apenas um estado de
  // UI. Ela só é atravessada com uma aprovação explícita registrada
  // (`approved_at`) para a ação vinculada à própria missão. O status posterior
  // da ação (executing/executed/failed) não apaga a aprovação já concedida.
  // Sem ação preparada não há o que aprovar: a etapa é apenas uma passagem.
  if (currentStep?.type === 'approval') {
    const approvalActionId = Number(mission.approval_action_id || 0);
    if (approvalActionId) {
      const approved = await db.get(
        `SELECT id FROM dot_action_queue
          WHERE id=? AND empresa_id=? AND approved_at IS NOT NULL
            AND status IN ('approved','executing','executed','failed') LIMIT 1`,
        [approvalActionId, empresaId],
      );
      if (!approved) {
        throw new Error('Aprovação explícita é obrigatória antes de avançar a missão.');
      }
    }
  }

  // A etapa executada é a etapa atual (OFFSET current): ela recebe o output e
  // é concluída aqui. `completed_at` não é reescrito em recuperações.
  if (currentStep?.id) {
    await db.run(
      "UPDATE dot_agent_mission_steps SET status='completed', output=COALESCE(?, output), completed_at=COALESCE(completed_at, ?) WHERE id=? AND empresa_id=?",
      [output?.trim().slice(0, 4000) || null, now, currentStep.id, empresaId],
    );
  }

  const next = Math.min(current + 1, total);
  const nextStep = await db.get(
    'SELECT id,type FROM dot_agent_mission_steps WHERE mission_id=? AND empresa_id=? ORDER BY id ASC LIMIT 1 OFFSET ?',
    [id, empresaId, next],
  );

  let status: DotAgentMission['status'] = 'working';
  let stepStatus = 'working';
  if (next >= total) {
    status = 'completed';
    stepStatus = 'completed';
  } else if (nextStep?.type === 'approval') {
    // waiting_approval representa o estado real: a etapa atual é a barreira.
    status = 'waiting_approval';
    stepStatus = 'waiting_approval';
  }

  if (nextStep?.id) {
    await db.run('UPDATE dot_agent_mission_steps SET status=? WHERE id=? AND empresa_id=?', [stepStatus, nextStep.id, empresaId]);
  }

  await db.run(
    'UPDATE dot_agent_missions SET current_step=?,status=?,updated_at=? WHERE id=? AND empresa_id=?',
    [next, status, now, id, empresaId],
  );
  return row(await db.get('SELECT * FROM dot_agent_missions WHERE id=? AND empresa_id=?', [id, empresaId]));
}
