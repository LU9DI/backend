/**
 * Worker de inicialização concorrente: roda `initDB()` em um processo Node
 * isolado (pool próprio) e imprime um snapshot JSON do schema em stdout.
 * Logs humanos vão para stderr para manter stdout parseável.
 */
import { initDB, closeDB, dbEngine } from '../../lib/db.js';
import { indexExists, requireSchema, tableColumns } from '../../lib/migrations.js';

process.env.NODE_ENV = 'test';
console.log = (...args: unknown[]) => console.error(...args);

const REQUIRED_INDEXES: Array<{ table: string; name: string }> = [
  { table: 'reviews', name: 'idx_reviews_empresa' },
  { table: 'empresas', name: 'idx_empresas_cnpj' },
  { table: 'empresas', name: 'idx_empresas_slug' },
  { table: 'usuarios', name: 'idx_usuarios_email' },
  { table: 'password_resets', name: 'idx_password_resets_usuario' },
  { table: 'dot_action_queue', name: 'ux_dot_action_queue_decision_option' },
  { table: 'dot_action_queue', name: 'ux_dot_action_queue_one_active_decision' },
  { table: 'dot_action_audit', name: 'idx_dot_action_audit_empresa' },
  { table: 'dot_action_audit', name: 'idx_dot_action_audit_action' },
];

let exitCode = 0;
try {
  await initDB();
  const { getDb } = await import('../../lib/db.js');
  const db = getDb();
  await requireSchema(db, {
    tables: ['empresas', 'usuarios', 'reviews', 'ai_usage', 'usage', 'password_resets', 'dot_action_queue', 'dot_action_audit'],
    columns: {
      reviews: ['createdAt', 'is_test'],
      usuarios: ['email', 'mfa_secret', 'mfa_enabled', 'mfa_backup_hashes', 'mfa_pending_secret'],
      dot_action_audit: ['metadata'],
    },
    indexes: REQUIRED_INDEXES,
  });

  const version: any = await db.get('SHOW server_version').catch(() => undefined);
  const indexSnapshot: Record<string, boolean> = {};
  for (const index of REQUIRED_INDEXES) {
    indexSnapshot[index.name] = await indexExists(db, index.table, index.name);
  }

  process.stdout.write(
    JSON.stringify({
      pid: process.pid,
      engine: dbEngine(),
      serverVersion: version?.server_version ?? null,
      reviewsColumns: await tableColumns(db, 'reviews'),
      usuariosColumns: await tableColumns(db, 'usuarios'),
      auditColumns: await tableColumns(db, 'dot_action_audit'),
      indexes: indexSnapshot,
    }),
  );
} catch (error: any) {
  console.error('init-db-worker falhou:', error?.stack || error);
  exitCode = 1;
} finally {
  await closeDB().catch((error) => {
    console.error('init-db-worker: closeDB falhou:', error);
    exitCode = 1;
  });
}
process.exitCode = exitCode;
