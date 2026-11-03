/**
 * Retenção/expurgo assistido da auditoria do Dot.
 *
 * Não é um job automático: nunca é agendado e nunca apaga nada por padrão.
 * - `plan`: apenas conta o que expiraria (dry-run);
 * - `export`: exporta as linhas expiradas para arquivo (sem apagar);
 * - `purge`: exige confirmação explícita (`confirm: true`) e é destinado a
 *   execução manual aprovada (LGPD/operação), após backup.
 *
 * A lista de tabelas é fechada (allowlist) para evitar SQL dinâmico arbitrário.
 */
import type { Database } from 'sqlite';
import { getDb, withDbTransaction } from '../lib/db.js';

export const DOT_AUDIT_RETENTION_DEFAULTS = {
  dot_action_audit: 365,
  dot_access_audit: 180,
} as const;

export type DotAuditRetentionTable = keyof typeof DOT_AUDIT_RETENTION_DEFAULTS;

const TABLES: Record<DotAuditRetentionTable, { dateColumn: string; label: string }> = {
  dot_action_audit: { dateColumn: 'created_at', label: 'Ações do Dot (preparação/aprovação/execução)' },
  dot_access_audit: { dateColumn: 'created_at', label: 'Acessos/permissões do Dot' },
};

export type RetentionPlanRow = {
  table: DotAuditRetentionTable;
  label: string;
  retention_days: number;
  cutoff: string;
  expired: number;
};

export type RetentionPurgeResult = {
  table: DotAuditRetentionTable;
  deleted: number;
  cutoff: string;
};

export function retentionCutoff(days: number, now = Date.now()): string {
  const safeDays = Math.max(1, Math.floor(Number(days) || 1));
  return new Date(now - safeDays * 86_400_000).toISOString();
}

export async function planDotAuditRetention(
  database: Database = getDb(),
  retention: Partial<Record<DotAuditRetentionTable, number>> = {},
  now = Date.now(),
): Promise<RetentionPlanRow[]> {
  const result: RetentionPlanRow[] = [];
  for (const table of Object.keys(TABLES) as DotAuditRetentionTable[]) {
    const days = Math.max(1, Math.floor(Number(retention[table] ?? DOT_AUDIT_RETENTION_DEFAULTS[table]) || 1));
    const cutoff = retentionCutoff(days, now);
    const row: any = await database.get(`SELECT COUNT(*) AS c FROM ${table} WHERE ${TABLES[table].dateColumn} < ?`, [cutoff]);
    result.push({
      table,
      label: TABLES[table].label,
      retention_days: days,
      cutoff,
      expired: Number(row?.c || 0),
    });
  }
  return result;
}

export async function exportExpiredDotAudit(
  database: Database = getDb(),
  retention: Partial<Record<DotAuditRetentionTable, number>> = {},
  now = Date.now(),
): Promise<Record<DotAuditRetentionTable, any[]>> {
  const output = {} as Record<DotAuditRetentionTable, any[]>;
  for (const table of Object.keys(TABLES) as DotAuditRetentionTable[]) {
    const days = Math.max(1, Math.floor(Number(retention[table] ?? DOT_AUDIT_RETENTION_DEFAULTS[table]) || 1));
    const cutoff = retentionCutoff(days, now);
    output[table] = await database.all(
      `SELECT * FROM ${table} WHERE ${TABLES[table].dateColumn} < ? ORDER BY ${TABLES[table].dateColumn} ASC LIMIT 10000`,
      [cutoff],
    );
  }
  return output;
}

/**
 * Apaga somente linhas comprovadamente anteriores ao cutoff. Exige
 * `confirm === true`; a ausência dessa flag retorna erro e não apaga nada.
 */
export async function purgeExpiredDotAudit(
  database: Database = getDb(),
  input: {
    confirm: boolean;
    retention?: Partial<Record<DotAuditRetentionTable, number>>;
    now?: number;
  },
): Promise<RetentionPurgeResult[]> {
  if (input.confirm !== true) {
    throw new Error('Expurgo de auditoria exige confirmação explícita (confirm: true).');
  }
  const now = input.now ?? Date.now();
  const retention = input.retention || {};
  const results: RetentionPurgeResult[] = [];

  await withDbTransaction(async (tx) => {
    for (const table of Object.keys(TABLES) as DotAuditRetentionTable[]) {
      const days = Math.max(1, Math.floor(Number(retention[table] ?? DOT_AUDIT_RETENTION_DEFAULTS[table]) || 1));
      const cutoff = retentionCutoff(days, now);
      const res = await tx.run(
        `DELETE FROM ${table} WHERE ${TABLES[table].dateColumn} < ?`,
        [cutoff],
      );
      results.push({ table, deleted: Number(res?.changes || 0), cutoff });
    }
  });
  return results;
}
