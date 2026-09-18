/**
 * Idempotência de webhooks (PayPal, MP, Stripe, n8n).
 * Mesmo event_id duas vezes → segunda chamada é no-op.
 */
import type { Database } from 'sqlite';
import { getDb } from './db.js';

export async function ensureWebhookIdempotency(db: Database = getDb()) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_dedupe (
      source TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT,
      action TEXT,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (source, event_id)
    )
  `);
  try {
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_webhook_dedupe_at ON webhook_dedupe(processed_at)`
    );
  } catch {
    /* ok */
  }
}

/**
 * Tenta "claim" do evento. true = processar agora; false = já processado.
 */
export async function claimWebhookEvent(
  opts: {
    source: string;
    eventId: string;
    eventType?: string | null;
    action?: string | null;
  },
  db: Database = getDb()
): Promise<{ isNew: boolean }> {
  const source = String(opts.source || 'unknown').slice(0, 40);
  const eventId = String(opts.eventId || '').trim().slice(0, 120);
  if (!eventId) return { isNew: true };

  await ensureWebhookIdempotency(db);

  try {
    await db.run(
      `INSERT INTO webhook_dedupe (source, event_id, event_type, action, processed_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        source,
        eventId,
        opts.eventType ? String(opts.eventType).slice(0, 80) : null,
        opts.action ? String(opts.action).slice(0, 80) : 'claimed',
      ]
    );
    return { isNew: true };
  } catch (e: any) {
    const msg = String(e?.message || e);
    const code = String(e?.code || '');
    if (code === '23505' || /unique|duplicate|constraint/i.test(msg)) {
      return { isNew: false };
    }
    // fallback SELECT
    const row = await db.get(
      `SELECT event_id FROM webhook_dedupe WHERE source = ? AND event_id = ?`,
      [source, eventId]
    );
    return { isNew: !row };
  }
}

export async function releaseWebhookEvent(
  source: string,
  eventId: string,
  db: Database = getDb()
) {
  if (!eventId) return;
  try {
    await db.run(
      `DELETE FROM webhook_dedupe WHERE source = ? AND event_id = ?`,
      [String(source).slice(0, 40), String(eventId).trim().slice(0, 120)]
    );
  } catch {
    /* ok */
  }
}

export async function updateWebhookAction(
  source: string,
  eventId: string,
  action: string,
  db: Database = getDb()
) {
  if (!eventId) return;
  try {
    await db.run(
      `UPDATE webhook_dedupe SET action = ? WHERE source = ? AND event_id = ?`,
      [String(action).slice(0, 80), source, eventId]
    );
  } catch {
    /* ok */
  }
}
