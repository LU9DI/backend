import { getDb } from '../lib/db.js';

export type DotActionAuditEvent =
  | 'prepared'
  | 'approved'
  | 'execution_started'
  | 'executed'
  | 'failed'
  | 'rejected';

async function ensureSchema() {
  const db = getDb();
  await db.exec(`CREATE TABLE IF NOT EXISTS dot_action_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id TEXT NOT NULL,
    action_id INTEGER NOT NULL,
    decision_id INTEGER NOT NULL,
    event TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_dot_action_audit_empresa_action ON dot_action_audit(empresa_id, action_id, id)');
}

export async function recordDotActionAudit(input: {
  empresaId: string;
  actionId: number;
  decisionId: number;
  event: DotActionAuditEvent;
  actorType: 'dot' | 'user' | 'system';
  actorId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await ensureSchema();
  const db = getDb();
  const result = await db.run(
    'INSERT INTO dot_action_audit (empresa_id,action_id,decision_id,event,actor_type,actor_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?) RETURNING id',
    [
      input.empresaId,
      input.actionId,
      input.decisionId,
      input.event,
      input.actorType,
      input.actorId || null,
      JSON.stringify(input.metadata || {}),
      new Date().toISOString(),
    ],
  );
  return { id: result.lastID, ...input };
}

export async function listDotActionAudit(empresaId: string, actionId: number) {
  await ensureSchema();
  return getDb().all(
    'SELECT * FROM dot_action_audit WHERE empresa_id = ? AND action_id = ? ORDER BY id ASC',
    [empresaId, actionId],
  );
}
