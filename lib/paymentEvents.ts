/**
 * Registro de eventos de pagamento + idempotência de webhooks.
 *
 * - payment_events: auditoria (pix, mp, paypal, stripe)
 * - webhook_processed: evita processar o mesmo evento 2x
 */
import type { Database } from 'sqlite';

export async function ensurePaymentTables(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS payment_events (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      external_id TEXT,
      empresa_id TEXT,
      plano_key TEXT,
      amount DOUBLE PRECISION,
      status TEXT NOT NULL,
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL
    )
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_processed (
      idempotency_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL,
      result TEXT
    )
  `);
  try {
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_payment_events_created ON payment_events(created_at)`
    );
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_payment_events_empresa ON payment_events(empresa_id)`
    );
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_payment_events_external ON payment_events(source, external_id)`
    );
  } catch {
    /* ok */
  }
}

function rid(): string {
  return `pe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function logPaymentEvent(
  db: Database,
  opts: {
    source: 'mercadopago' | 'paypal' | 'stripe' | string;
    event_type: string;
    external_id?: string | null;
    empresa_id?: string | null;
    plano_key?: string | null;
    amount?: number | null;
    status: string;
    detail?: string | null;
  }
): Promise<void> {
  try {
    await ensurePaymentTables(db);
    await db.run(
      `INSERT INTO payment_events
        (id, source, event_type, external_id, empresa_id, plano_key, amount, status, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rid(),
        String(opts.source).slice(0, 40),
        String(opts.event_type).slice(0, 80),
        opts.external_id ? String(opts.external_id).slice(0, 120) : null,
        opts.empresa_id || null,
        opts.plano_key || null,
        opts.amount ?? null,
        String(opts.status).slice(0, 40),
        opts.detail ? String(opts.detail).slice(0, 500) : null,
        new Date().toISOString(),
      ]
    );
  } catch (e: any) {
    console.warn('[paymentEvents] log falhou:', e?.message || e);
  }
}

/**
 * Retorna true se ESTE webhook ainda não foi processado (grava a chave).
 * Retorna false se já foi processado (idempotente).
 */
export async function claimWebhookOnce(
  db: Database,
  source: string,
  idempotencyKey: string
): Promise<boolean> {
  await ensurePaymentTables(db);
  const key = `${source}:${idempotencyKey}`.slice(0, 200);
  try {
    await db.run(
      `INSERT INTO webhook_processed (idempotency_key, source, processed_at, result)
       VALUES (?, ?, ?, ?)`,
      [key, source, new Date().toISOString(), 'claimed']
    );
    return true;
  } catch {
    return false;
  }
}

export async function markWebhookResult(
  db: Database,
  source: string,
  idempotencyKey: string,
  result: string
): Promise<void> {
  const key = `${source}:${idempotencyKey}`.slice(0, 200);
  try {
    await db.run(`UPDATE webhook_processed SET result = ? WHERE idempotency_key = ?`, [
      String(result).slice(0, 200),
      key,
    ]);
  } catch {
    /* ok */
  }
}

export async function recentPaymentEvents(db: Database, limit = 40) {
  await ensurePaymentTables(db);
  return db.all(
    `SELECT * FROM payment_events ORDER BY created_at DESC LIMIT ?`,
    [Math.min(100, Math.max(1, limit))]
  );
}
