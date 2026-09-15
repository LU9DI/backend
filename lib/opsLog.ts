/** Logs operacionais (webhooks, PDF). Postgres-safe. */
import type { Database } from 'sqlite';

export async function ensureOpsTables(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      event_type TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      detail TEXT,
      payload_summary TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pdf_generation_log (
      id SERIAL PRIMARY KEY,
      empresa_id TEXT,
      empresa_nome TEXT,
      mes TEXT,
      status TEXT NOT NULL,
      bytes INTEGER,
      duration_ms INTEGER,
      error TEXT,
      auth_mode TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  try {
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_events_created ON webhook_events(created_at)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_pdf_log_created ON pdf_generation_log(created_at)`);
  } catch {
    /* ok */
  }
}

export async function logWebhookEvent(
  db: Database,
  opts: {
    source: string;
    event_type?: string | null;
    status?: 'ok' | 'error' | 'ignored';
    detail?: string | null;
    payload_summary?: string | null;
  }
): Promise<void> {
  try {
    await ensureOpsTables(db);
    await db.run(
      `INSERT INTO webhook_events (source, event_type, status, detail, payload_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        String(opts.source || 'unknown').slice(0, 40),
        opts.event_type ? String(opts.event_type).slice(0, 80) : null,
        opts.status || 'ok',
        opts.detail ? String(opts.detail).slice(0, 500) : null,
        opts.payload_summary ? String(opts.payload_summary).slice(0, 1000) : null,
        new Date().toISOString(),
      ]
    );
  } catch (e: any) {
    console.warn('[opsLog] webhook log falhou:', e?.message || e);
  }
}

export async function logPdfGeneration(
  db: Database,
  opts: {
    empresa_id?: string | null;
    empresa_nome?: string | null;
    mes?: string | null;
    status: 'ok' | 'error' | 'forbidden';
    bytes?: number | null;
    duration_ms?: number | null;
    error?: string | null;
    auth_mode?: string | null;
  }
): Promise<void> {
  try {
    await ensureOpsTables(db);
    await db.run(
      `INSERT INTO pdf_generation_log
        (empresa_id, empresa_nome, mes, status, bytes, duration_ms, error, auth_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        opts.empresa_id || null,
        opts.empresa_nome ? String(opts.empresa_nome).slice(0, 120) : null,
        opts.mes || null,
        opts.status,
        opts.bytes ?? null,
        opts.duration_ms ?? null,
        opts.error ? String(opts.error).slice(0, 500) : null,
        opts.auth_mode || null,
        new Date().toISOString(),
      ]
    );
  } catch (e: any) {
    console.warn('[opsLog] pdf log falhou:', e?.message || e);
  }
}

export async function recentWebhookEvents(db: Database, limit = 30) {
  await ensureOpsTables(db);
  return db.all(`SELECT * FROM webhook_events ORDER BY id DESC LIMIT ?`, [
    Math.min(100, Math.max(1, limit)),
  ]);
}

export async function recentPdfLogs(db: Database, limit = 30) {
  await ensureOpsTables(db);
  return db.all(`SELECT * FROM pdf_generation_log ORDER BY id DESC LIMIT ?`, [
    Math.min(100, Math.max(1, limit)),
  ]);
}

export async function webhookHealth(db: Database, source: string, hours = 24) {
  await ensureOpsTables(db);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const row = await db.get(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as ok_count,
       SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as err_count,
       MAX(created_at) as last_at
     FROM webhook_events
     WHERE source = ? AND created_at >= ?`,
    [source, since]
  );
  return {
    total: Number(row?.total || 0),
    ok: Number(row?.ok_count || 0),
    errors: Number(row?.err_count || 0),
    last_at: row?.last_at || null,
  };
}
