import { getDb } from '../lib/db.js';
import { requireDotAccess, type DotAccessAction, type DotAccessResource } from './dotAccessControl.js';

export type DotToolOperation = DotAccessAction;
export type DotToolDefinition = {
  id: string;
  description: string;
  resource: DotAccessResource;
  operation: DotToolOperation;
  risk: 'low' | 'medium' | 'high';
  requiresApproval: boolean;
  execute: (empresaId: string, input: Record<string, unknown>) => Promise<unknown>;
};

async function ensureSchema() {
  const db = getDb();
  await db.exec(`CREATE TABLE IF NOT EXISTS dot_tool_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id TEXT NOT NULL,
    tool_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    allowed INTEGER NOT NULL,
    actor_type TEXT NOT NULL,
    actor_user_id TEXT,
    input_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL
  )`);
  const columns = await db.all('PRAGMA table_info(dot_tool_audit)');
  if (!(columns || []).some((column: any) => String(column.name) === 'actor_user_id')) {
    await db.exec('ALTER TABLE dot_tool_audit ADD COLUMN actor_user_id TEXT');
  }
  await db.exec('CREATE INDEX IF NOT EXISTS idx_dot_tool_audit_empresa ON dot_tool_audit(empresa_id, created_at)');
}

async function audit(input: {
  empresaId: string;
  toolId: string;
  operation: string;
  allowed: boolean;
  actorType: string;
  actorUserId?: string | null;
  input?: Record<string, unknown>;
  result?: unknown;
  error?: string;
}) {
  await ensureSchema();
  await getDb().run(
    'INSERT INTO dot_tool_audit (empresa_id,tool_id,operation,allowed,actor_type,actor_user_id,input_json,result_json,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [input.empresaId, input.toolId, input.operation, input.allowed ? 1 : 0, input.actorType, input.actorUserId || null, JSON.stringify(input.input || {}), input.result == null ? null : JSON.stringify(input.result), input.error || null, new Date().toISOString()],
  );
}

const tools: Record<string, DotToolDefinition> = {
  'company.workspace.read': {
    id: 'company.workspace.read',
    description: 'Lê o contexto operacional básico da empresa para o DOT.',
    resource: 'filtra',
    operation: 'read',
    risk: 'low',
    requiresApproval: false,
    async execute(empresaId) {
      const row = await getDb().get('SELECT id,nome_empresa,status,plan,slug FROM empresas WHERE id=? LIMIT 1', [empresaId]);
      if (!row) throw new Error('Empresa não encontrada.');
      return { empresa: row };
    },
  },
  'reviews.read': {
    id: 'reviews.read',
    description: 'Lê avaliações da empresa para análise interna.',
    resource: 'filtra',
    operation: 'read',
    risk: 'low',
    requiresApproval: false,
    async execute(empresaId, input) {
      const limit = Math.min(Math.max(Number(input.limit || 20), 1), 100);
      return getDb().all('SELECT id,name,rating,comment,ai_tags,createdAt FROM reviews WHERE empresa_id=? ORDER BY createdAt DESC LIMIT ?', [empresaId, limit]);
    },
  },
  'reviews.analyze': {
    id: 'reviews.analyze',
    description: 'Agrega sinais básicos das avaliações sem efeito externo.',
    resource: 'filtra',
    operation: 'analyze',
    risk: 'low',
    requiresApproval: false,
    async execute(empresaId) {
      const row = await getDb().get('SELECT COUNT(*) AS total, AVG(rating) AS average_rating FROM reviews WHERE empresa_id=?', [empresaId]);
      return { total: Number(row?.total || 0), averageRating: row?.average_rating == null ? null : Number(row.average_rating) };
    },
  },
  'dot.goals.read': {
    id: 'dot.goals.read',
    description: 'Consulta os objetivos operacionais atuais do DOT.',
    resource: 'operations',
    operation: 'read',
    risk: 'low',
    requiresApproval: false,
    async execute(empresaId) {
      return getDb().all('SELECT id,title,description,status,progress,source,updated_at,last_activity_at FROM dot_agent_goals WHERE empresa_id=? AND status<>? ORDER BY updated_at DESC LIMIT 50', [empresaId, 'archived']);
    },
  },
};

export function listDotTools(): Array<Omit<DotToolDefinition, 'execute'>> {
  return Object.values(tools).map(({ execute, ...definition }) => definition);
}

export function getDotToolDefinition(toolId: string): Omit<DotToolDefinition, 'execute'> | null {
  const definition = tools[String(toolId || '')];
  if (!definition) return null;
  const { execute, ...rest } = definition;
  return rest;
}

/**
 * Ferramentas com efeito potencialmente relevante (execução, envio externo ou
 * risco médio/alto) exigem, além da permissão granular, a sessão administrativa
 * do Dot obtida com o PIN da empresa. Hoje todas as ferramentas registradas são
 * de leitura/baixa criticidade — a classificação existe para o registro futuro.
 */
export function dotToolRequiresAdminSession(
  definition: Pick<DotToolDefinition, 'operation' | 'risk'>,
): boolean {
  return (
    definition.operation === 'execute' ||
    definition.operation === 'external_send' ||
    definition.risk === 'medium' ||
    definition.risk === 'high'
  );
}

export async function invokeDotTool(input: {
  empresaId: string;
  toolId: string;
  actorType: 'dot' | 'user' | 'system';
  actorUserId?: string | null;
  input?: Record<string, unknown>;
}) {
  const definition = tools[input.toolId];
  if (!definition) throw new Error('Ferramenta DOT não registrada.');
  if (definition.requiresApproval) throw new Error('Esta ferramenta exige aprovação e não pode ser chamada diretamente.');
  const params = input.input || {};
  try {
    await requireDotAccess(input.empresaId, definition.resource, definition.operation, input.actorUserId || null, { toolId: definition.id, actorType: input.actorType, actorUserId: input.actorUserId || null });
    const result = await definition.execute(input.empresaId, params);
    await audit({ ...input, operation: definition.operation, allowed: true, result });
    return { ok: true, tool: definition.id, result };
  } catch (error: any) {
    const message = String(error?.message || error);
    await audit({ ...input, operation: definition.operation, allowed: false, error: message });
    throw error;
  }
}
