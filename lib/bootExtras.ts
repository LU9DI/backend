/** Extras de boot chamados de forma isolada. */
import type { Express } from 'express';

export async function applyPublicRateLimit(app: Express) {
  try {
    const { mountPublicRateLimit } = await import('../middleware/rateLimitPublic.js');
    mountPublicRateLimit(app);
  } catch (e: any) {
    console.warn('rate-limit OFF:', e?.message || e);
  }
}

export async function ensureWebhookDedupe() {
  try {
    const { ensureWebhookIdempotency } = await import('./webhookIdempotency.js');
    const { getDb } = await import('./db.js');
    await ensureWebhookIdempotency(getDb());
  } catch (e: any) {
    console.warn('webhook dedupe schema:', e?.message || e);
  }
}
