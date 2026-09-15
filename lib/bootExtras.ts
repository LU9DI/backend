/** Extras de boot isolados. */
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

export async function initObservability(app: Express) {
  try {
    const { requestLogMiddleware } = await import('../middleware/security.js');
    app.use(requestLogMiddleware);
  } catch (e: any) {
    console.warn('request log OFF:', e?.message || e);
  }
  try {
    const { initSentryOptional } = await import('./sentry.js');
    await initSentryOptional();
  } catch (e: any) {
    console.warn('sentry OFF:', e?.message || e);
  }
}
