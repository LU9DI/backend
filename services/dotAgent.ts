import { getDb } from '../lib/db.js';

/**
 * Objetivos do agente Dot.
 *
 * Um objetivo é a intenção persistida do dono da empresa ("reduzir
 * reclamações sobre tempo de espera"). Cada objetivo pode ter uma missão
 * associada (ver `dotAgentMissions`), que executa o trabalho em etapas.
 *
 * Isolamento: toda leitura/escrita é sempre escopada por `empresa_id`. Nenhuma
 * função aceita id sem o tenant e nenhuma devolve dados de outra empresa.
 */

export type DotAgentGoalStatus = 'active' | 'paused' | 'completed' | 'archived';

export type DotAgentGoal = {
  id: number;
  title: string;
  description: string | null;
  status: DotAgentGoalStatus;
  progress: number;
  source: string;
  created_at: string;
  updated_at: string;
  last_activity_at: string | null;
};

export type DotAgentWorkspace = {
  goals: DotAgentGoal[];
  summary: { active: number; attention: number };
};

const GOAL_STATUSES: DotAgentGoalStatus[] = ['active', 'paused', 'completed', 'archived'];
const TITLE_MAX = 180;
const DESCRIPTION_MAX = 2000;
const SOURCE_MAX = 60;

// Um objetivo ativo sem nenhuma atividade recente precisa de atenção do dono.
const ATTENTION_STALE_MS = Math.max(
  60_000,
  Number(process.env.DOT_GOAL_ATTENTION_STALE_MS || 7 * 24 * 60 * 60 * 1000),
);

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toGoal(row: Record<string, unknown>): DotAgentGoal {
  return {
    id: num(row.id),
    title: String(row.title ?? ''),
    description: row.description === null || row.description === undefined ? null : String(row.description),
    status: String(row.status) as DotAgentGoalStatus,
    progress: num(row.progress),
    source: String(row.source ?? 'owner'),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
    last_activity_at: row.last_activity_at === null || row.last_activity_at === undefined
      ? null
      : String(row.last_activity_at),
  };
}

export async function ensureDotAgentSchema() {
  const db = getDb();
  await db.exec(`CREATE TABLE IF NOT EXISTS dot_agent_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    progress INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'owner',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_activity_at TEXT
  )`);
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_dot_agent_goals_empresa ON dot_agent_goals(empresa_id, status, updated_at)',
  );
}

function requireEmpresaId(empresaId: string): string {
  const value = String(empresaId || '').trim();
  if (!value) throw new Error('Empresa é obrigatória para operar objetivos do agente DOT.');
  return value;
}

function normalizeStatus(value: unknown): DotAgentGoalStatus {
  const status = String(value || '').trim().toLowerCase() as DotAgentGoalStatus;
  if (!GOAL_STATUSES.includes(status)) {
    throw new Error(`Status de objetivo inválido. Use: ${GOAL_STATUSES.join(', ')}.`);
  }
  return status;
}

function normalizeProgress(value: unknown): number {
  const progress = Math.round(Number(value));
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
    throw new Error('Progresso do objetivo deve ser um número entre 0 e 100.');
  }
  return progress;
}

export async function listDotAgentGoals(empresaId: string): Promise<DotAgentGoal[]> {
  const tenant = requireEmpresaId(empresaId);
  await ensureDotAgentSchema();
  const rows = await getDb().all(
    `SELECT id, title, description, status, progress, source, created_at, updated_at, last_activity_at
       FROM dot_agent_goals WHERE empresa_id = ? AND status <> 'archived'
      ORDER BY updated_at DESC LIMIT 50`,
    [tenant],
  );
  return (rows || []).map(toGoal);
}

export async function createDotAgentGoal(
  empresaId: string,
  input: { title?: unknown; description?: unknown; source?: unknown },
): Promise<DotAgentGoal> {
  const tenant = requireEmpresaId(empresaId);

  const title = String(input?.title ?? '').trim();
  if (title.length < 3 || title.length > TITLE_MAX) {
    throw new Error(`Título do objetivo deve ter entre 3 e ${TITLE_MAX} caracteres.`);
  }

  const descriptionRaw = String(input?.description ?? '').trim();
  if (descriptionRaw.length > DESCRIPTION_MAX) {
    throw new Error(`Descrição do objetivo deve ter no máximo ${DESCRIPTION_MAX} caracteres.`);
  }
  const source = String(input?.source ?? 'owner').trim().slice(0, SOURCE_MAX) || 'owner';

  await ensureDotAgentSchema();
  const db = getDb();
  const now = new Date().toISOString();
  const result = await db.run(
    `INSERT INTO dot_agent_goals
      (empresa_id, title, description, status, progress, source, created_at, updated_at, last_activity_at)
      VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
    [tenant, title, descriptionRaw || null, 'active', 0, source, now, now, now],
  ) as unknown as { changes: number; lastID?: number | bigint; lastInsertRowid?: number | bigint; id?: number | bigint };
  const id = num(result?.lastID ?? result?.lastInsertRowid ?? result?.id);
  const created = await db.get(
    `SELECT id, title, description, status, progress, source, created_at, updated_at, last_activity_at
       FROM dot_agent_goals WHERE id = ? AND empresa_id = ?`,
    [id, tenant],
  );
  if (!created) throw new Error('Objetivo não pôde ser persistido.');
  return toGoal(created);
}

export async function updateDotAgentGoal(
  empresaId: string,
  goalId: number,
  patch: { title?: unknown; description?: unknown; status?: unknown; progress?: unknown },
): Promise<DotAgentGoal | null> {
  const tenant = requireEmpresaId(empresaId);
  const id = Math.trunc(Number(goalId));
  if (!Number.isFinite(id) || id <= 0) throw new Error('ID de objetivo inválido.');

  await ensureDotAgentSchema();
  const db = getDb();
  const current = await db.get(
    `SELECT id, title, description, status, progress, source, created_at, updated_at, last_activity_at
       FROM dot_agent_goals WHERE id = ? AND empresa_id = ?`,
    [id, tenant],
  );
  if (!current) return null;

  const next = toGoal(current);

  if (patch?.title !== undefined) {
    const title = String(patch.title).trim();
    if (title.length < 3 || title.length > TITLE_MAX) {
      throw new Error(`Título do objetivo deve ter entre 3 e ${TITLE_MAX} caracteres.`);
    }
    next.title = title;
  }
  if (patch?.description !== undefined) {
    const description = String(patch.description ?? '').trim();
    if (description.length > DESCRIPTION_MAX) {
      throw new Error(`Descrição do objetivo deve ter no máximo ${DESCRIPTION_MAX} caracteres.`);
    }
    next.description = description || null;
  }
  if (patch?.status !== undefined) {
    next.status = normalizeStatus(patch.status);
  }
  if (patch?.progress !== undefined) {
    next.progress = normalizeProgress(patch.progress);
  }

  const now = new Date().toISOString();
  await db.run(
    `UPDATE dot_agent_goals SET title = ?, description = ?, status = ?, progress = ?,
       updated_at = ?, last_activity_at = ? WHERE id = ? AND empresa_id = ?`,
    [next.title, next.description, next.status, next.progress, now, now, id, tenant],
  );

  const updated = await db.get(
    `SELECT id, title, description, status, progress, source, created_at, updated_at, last_activity_at
       FROM dot_agent_goals WHERE id = ? AND empresa_id = ?`,
    [id, tenant],
  );
  return updated ? toGoal(updated) : null;
}

/**
 * Registra atividade do agente no objetivo (usado pelo runner de missões).
 * Não altera status/progresso: apenas mantém o indicador de atividade fresco.
 */
export async function touchDotAgentGoal(empresaId: string, goalId: number, progress?: number): Promise<void> {
  const tenant = String(empresaId || '').trim();
  const id = Math.trunc(Number(goalId));
  if (!tenant || !Number.isFinite(id) || id <= 0) return;
  const now = new Date().toISOString();
  const safeProgress = progress === undefined ? null : Math.max(0, Math.min(100, Math.round(Number(progress))));
  try {
    await getDb().run(
      `UPDATE dot_agent_goals SET last_activity_at = ?, updated_at = ?,
         progress = COALESCE(?, progress) WHERE id = ? AND empresa_id = ?`,
      [now, now, safeProgress, id, tenant],
    );
  } catch {
    // Atividade é telemetria do objetivo: nunca deve derrubar a missão.
  }
}

export async function getDotAgentWorkspace(empresaId: string): Promise<DotAgentWorkspace> {
  const goals = await listDotAgentGoals(empresaId);
  const cutoff = Date.now() - ATTENTION_STALE_MS;
  const active = goals.filter((goal) => goal.status === 'active');
  const attention = active.filter((goal) => {
    const stamp = goal.last_activity_at ? Date.parse(goal.last_activity_at) : Number.NaN;
    return !Number.isFinite(stamp) || stamp < cutoff;
  });
  return { goals, summary: { active: active.length, attention: attention.length } };
}
