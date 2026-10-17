import { getDb } from '../lib/db.js';

export type DotActionAuditEvent =
  | 'prepared'
  | 'approved'
  | 'execution_started'
  | 'executed'
  | 'failed';

export type DotActionAuditInput = {
  empresaId: string;
  actionId: number;
  decisionId?: number | null;
  event: DotActionAuditEvent;
  actorType: 'dot' | 'user' | 'system';
  actorId?: string | null;
  metadata?: unknown;
};

export async function ensureDotActionAuditSchema() {
  const db = getDb();
  await db.exec(`CREATE TABLE IF NOT EXISTS dot_action_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id TEXT NOT NULL,
    action_id INTEGER NOT NULL,
    decision_id INTEGER,
    event TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL
  )`);
  // Compatibilidade com bancos criados antes do campo metadata.
  // CREATE TABLE IF NOT EXISTS não altera uma tabela já existente.
  try {
    await db.exec('ALTER TABLE dot_action_audit ADD COLUMN metadata TEXT');
  } catch (error: any) {
    const message = String(error?.message || error).toLowerCase();
    if (!message.includes('duplicate column') && !message.includes('already exists')) {
      throw error;
    }
  }

  await db.exec('CREATE INDEX IF NOT EXISTS idx_dot_action_audit_empresa ON dot_action_audit(empresa_id, created_at)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_dot_action_audit_action ON dot_action_audit(empresa_id, action_id, created_at)');
}

export async function recordDotActionAudit(input: DotActionAuditInput) {
  await ensureDotActionAuditSchema();
  const db = getDb();
  await db.run(
    `INSERT INTO dot_action_audit
      (empresa_id, action_id, decision_id, event, actor_type, actor_id, metadata, created_at)
      VALUES (?,?,?,?,?,?,?,?)`,
    [
      input.empresaId,
      input.actionId,
      input.decisionId ?? null,
      input.event,
      input.actorType,
      input.actorId || null,
      input.metadata == null ? null : JSON.stringify(input.metadata).slice(0, 12000),
      new Date().toISOString(),
    ],
  );
}

// Portado da linha canônica 1.3.0: leitura da trilha de auditoria de uma ação,
// sempre escopada pela empresa (o master expõe esta função e o teste
// tests/dotRedaction e o núcleo DOT dependem dela).
export async function listDotActionAudit(empresaId: string, actionId: number) {
  await ensureDotActionAuditSchema();
  return getDb().all(
    'SELECT * FROM dot_action_audit WHERE empresa_id = ? AND action_id = ? ORDER BY id ASC',
    [empresaId, actionId],
  );
}
