import { getDb } from '../lib/db.js';
import { requireSchema } from '../lib/migrations.js';

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

/**
 * Verifica o schema de auditoria — sem DDL.
 * Tabela/coluna/índices são criados apenas em `runCentralMigrations`.
 */
export async function ensureDotActionAuditSchema() {
  const db = getDb();
  await requireSchema(db, {
    tables: ['dot_action_audit'],
    columns: {
      dot_action_audit: ['empresa_id', 'action_id', 'decision_id', 'event', 'actor_type', 'metadata'],
    },
    indexes: [
      { table: 'dot_action_audit', name: 'idx_dot_action_audit_empresa' },
      { table: 'dot_action_audit', name: 'idx_dot_action_audit_action' },
    ],
  });
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
