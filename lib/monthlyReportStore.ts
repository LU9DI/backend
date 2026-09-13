import type { Database } from 'sqlite';

/**
 * Histórico/idempotência dos relatórios mensais.
 * Um relatório é único por empresa + ciclo.
 */
export async function ensureMonthlyReportSchema(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS monthly_reports (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      cycle_key TEXT NOT NULL,
      cycle_start TIMESTAMPTZ NOT NULL,
      cycle_end TIMESTAMPTZ NOT NULL,
      plan TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'generated',
      file_path TEXT,
      file_name TEXT,
      bytes INTEGER,
      generated_at TIMESTAMPTZ NOT NULL,
      error TEXT,
      UNIQUE (empresa_id, cycle_key)
    )
  `);

  try {
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_monthly_reports_empresa ON monthly_reports(empresa_id)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_monthly_reports_cycle ON monthly_reports(cycle_key)`);
  } catch {
    // Índices são apenas otimização.
  }
}

export async function monthlyReportExists(
  db: Database,
  empresaId: string,
  cycleKey: string
): Promise<boolean> {
  const row = await db.get(
    `SELECT id FROM monthly_reports WHERE empresa_id = ? AND cycle_key = ? LIMIT 1`,
    [empresaId, cycleKey]
  );
  return Boolean(row);
}

export async function saveMonthlyReport(
  db: Database,
  input: {
    id: string;
    empresaId: string;
    cycleKey: string;
    cycleStart: string;
    cycleEnd: string;
    plan: string;
    status?: string;
    filePath?: string | null;
    fileName?: string | null;
    bytes?: number | null;
    error?: string | null;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO monthly_reports
      (id, empresa_id, cycle_key, cycle_start, cycle_end, plan, status,
       file_path, file_name, bytes, generated_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (empresa_id, cycle_key) DO UPDATE SET
       status = excluded.status,
       file_path = excluded.file_path,
       file_name = excluded.file_name,
       bytes = excluded.bytes,
       generated_at = excluded.generated_at,
       error = excluded.error`,
    [
      input.id,
      input.empresaId,
      input.cycleKey,
      input.cycleStart,
      input.cycleEnd,
      input.plan,
      input.status || 'generated',
      input.filePath || null,
      input.fileName || null,
      input.bytes ?? null,
      new Date().toISOString(),
      input.error || null,
    ]
  );
}
