import type { Database } from 'sqlite';

export type StoredReport = {
  id: string;
  empresa_id: string;
  cycle_key: string;
  cycle_start: string;
  cycle_end: string;
  mes_ano: string;
  lang: string;
  status: 'processing' | 'ready';
  pdf_base64?: string | null;
  created_at?: string | null;
  generated_at?: string | null;
};

export async function ensureReportPdfSchema(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS report_pdf_documents (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      cycle_key TEXT NOT NULL,
      cycle_start TIMESTAMPTZ NOT NULL,
      cycle_end TIMESTAMPTZ NOT NULL,
      mes_ano TEXT NOT NULL,
      lang TEXT NOT NULL DEFAULT 'pt',
      status TEXT NOT NULL DEFAULT 'processing',
      pdf_base64 TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      generated_at TIMESTAMPTZ,
      UNIQUE (empresa_id, cycle_key)
    )
  `);
  try {
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_report_pdf_empresa ON report_pdf_documents(empresa_id)`);
  } catch {
    /* índice já existente */
  }
}

export async function getStoredReport(
  db: Database,
  empresaId: string,
  cycleKey: string
): Promise<StoredReport | null> {
  return db.get<StoredReport>(
    'SELECT * FROM report_pdf_documents WHERE empresa_id = ? AND cycle_key = ?',
    [empresaId, cycleKey]
  );
}

export async function claimReportGeneration(
  db: Database,
  input: {
    id: string;
    empresaId: string;
    cycleKey: string;
    cycleStart: string;
    cycleEnd: string;
    mesAno: string;
    lang: string;
  }
): Promise<boolean> {
  try {
    const stale = await db.get<{ id?: string; created_at?: string }>(
      "SELECT id, created_at FROM report_pdf_documents WHERE empresa_id = ? AND cycle_key = ? AND status = 'processing'",
      [input.empresaId, input.cycleKey]
    );
    if (stale?.id && stale.created_at) {
      const age = Date.now() - new Date(stale.created_at).getTime();
      if (Number.isFinite(age) && age > 15 * 60 * 1000) {
        await db.run("DELETE FROM report_pdf_documents WHERE id = ? AND status = 'processing'", [stale.id]);
      }
    }
    await db.run(
      `INSERT INTO report_pdf_documents
       (id, empresa_id, cycle_key, cycle_start, cycle_end, mes_ano, lang, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')`,
      [
        input.id,
        input.empresaId,
        input.cycleKey,
        input.cycleStart,
        input.cycleEnd,
        input.mesAno,
        input.lang,
      ]
    );
    return true;
  } catch {
    return false;
  }
}

export async function saveGeneratedReport(
  db: Database,
  id: string,
  pdf: Buffer,
  lang: string
): Promise<void> {
  await db.run(
    `UPDATE report_pdf_documents
     SET pdf_base64 = ?, lang = ?, status = 'ready', generated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [pdf.toString('base64'), lang, id]
  );
}

export async function releaseReportClaim(db: Database, id: string): Promise<void> {
  await db.run(
    `DELETE FROM report_pdf_documents
     WHERE id = ? AND status = 'processing'`,
    [id]
  );
}
