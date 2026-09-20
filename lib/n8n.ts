/**
 * Integração n8n — saída (API → n8n) e helpers de inbound.
 *
 * Env:
 *   N8N_WEBHOOK_URL=https://seu-n8n.../webhook/filtra-ia
 *   N8N_WEBHOOK_SECRET=opcional (header X-Filtra-Secret na saída)
 *   N8N_INBOUND_SECRET=opcional (entrada n8n → API; fallback = WEBHOOK_SECRET)
 *   N8N_ENABLED=1
 *   N8N_TIMEOUT_MS=8000
 */

import crypto from 'crypto';
import { enqueueRetry } from './retryQueue.js';

export type N8nEvent =
  | 'trial.ativado'
  | 'payment.confirmado'
  | 'payment.cancelado'
  | 'review.critica'
  | 'review.nova'
  | 'lead.whatsapp'
  | 'lead.captured'
  | 'lead.qualified'
  | 'lead.followup.requested'
  | 'lead.crm_sync.requested'
  | 'empresa.bloqueada'
  | 'ping';

export function n8nConfigured(): boolean {
  const url = process.env.N8N_WEBHOOK_URL?.trim();
  if (!url) return false;
  const flag = String(process.env.N8N_ENABLED || '1').toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  return true;
}

export function n8nWebhookUrl(): string {
  return (process.env.N8N_WEBHOOK_URL || '').trim();
}

function timeoutMs(): number {
  return Math.max(2000, Number(process.env.N8N_TIMEOUT_MS || 8000));
}

export async function queueN8nEvent(
  event: N8nEvent | string,
  payload: Record<string, unknown> = {},
  options: { dedupeKey?: string | null; delayMs?: number; maxAttempts?: number } = {}
): Promise<number | null> {
  if (!n8nConfigured()) return null;

  if (event === 'lead.followup.requested') {
    const requestedChannel = String(payload.channel || payload.preferred_channel || '').trim().toLowerCase();
    if (requestedChannel && requestedChannel !== 'email') {
      const channelUrlEnv: Record<string, string> = {
        whatsapp: 'WHATSAPP_SEND_URL',
        telegram: 'TELEGRAM_SEND_URL',
        wechat: 'WECHAT_SEND_URL',
      };
      const urlEnv = channelUrlEnv[requestedChannel];
      const telegramBotReady =
        requestedChannel === 'telegram' &&
        Boolean(String(process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || '').trim());
      if (!telegramBotReady && (!urlEnv || !String(process.env[urlEnv] || '').trim())) {
        throw new Error('Canal de follow-up não operacional: ' + requestedChannel);
      }
    }
  }

  const eventId = String(payload.event_id || crypto.randomUUID());
  const body = {
    event,
    source: 'filtra-ia',
    event_id: eventId,
    ts: new Date().toISOString(),
    ...payload,
  };
  const dedupeKey = options.dedupeKey || String(payload.dedupe_key || ('n8n:' + event + ':' + eventId));
  const idempotencyKey = String(payload.idempotency_key || dedupeKey);

  return enqueueRetry({
    jobType: 'n8n_webhook',
    payload: { ...body, idempotency_key: idempotencyKey },
    dedupeKey,
    delayMs: options.delayMs,
    maxAttempts: options.maxAttempts,
  });
}

export async function sendN8nWebhook(
  event: N8nEvent | string,
  payload: Record<string, unknown> = {}
): Promise<boolean> {
  if (!n8nConfigured()) return false;
  const url = n8nWebhookUrl();
  const body = {
    event,
    source: 'filtra-ia',
    ts: new Date().toISOString(),
    ...payload,
  };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Filtra.IA/n8n',
  };
  const secret = process.env.N8N_WEBHOOK_SECRET?.trim();
  if (secret) headers['X-Filtra-Secret'] = secret;
  const idempotencyKey = String(payload.idempotency_key || payload.dedupe_key || payload.event_id || '');
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
  if (process.env.N8N_API_KEY?.trim()) headers['X-N8N-API-KEY'] = process.env.N8N_API_KEY.trim();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs());
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.warn('[n8n] ' + event + ' HTTP ' + res.status + ': ' + txt.slice(0, 200));
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn('[n8n] ' + event + ' fail: ' + (e?.message || e));
    return false;
  } finally {
    clearTimeout(t);
  }
}

export function notifyN8n(
  event: N8nEvent | string,
  payload: Record<string, unknown> = {}
): void {
  if (!n8nConfigured()) return;
  void queueN8nEvent(event, payload).then((id) => {
    if (id != null) console.log('[n8n] ' + event + ' enfileirado #' + id);
  }).catch((e: any) => {
    console.error('[n8n] ' + event + ' não pôde ser enfileirado:', e?.message || e);
  });
}

export async function notifyN8nAsync(
  event: N8nEvent | string,
  payload: Record<string, unknown> = {}
): Promise<boolean> {
  if (!n8nConfigured()) return false;

  const url = n8nWebhookUrl();
  const body = {
    event,
    source: 'filtra-ia',
    ts: new Date().toISOString(),
    ...payload,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Filtra.IA/n8n',
  };
  const secret = process.env.N8N_WEBHOOK_SECRET?.trim();
  if (secret) headers['X-Filtra-Secret'] = secret;
  const idempotencyKey = String(payload.idempotency_key || payload.dedupe_key || payload.event_id || '');
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs());

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.warn(`[n8n] ${event} HTTP ${res.status}: ${txt.slice(0, 160)}`);
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn(`[n8n] ${event} fail:`, e?.message || e);
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function dispatchN8nEvent(
  event: string,
  payload: Record<string, unknown>,
  context?: { empresaId?: string; slug?: string | null }
): Promise<boolean> {
  return notifyN8nAsync(event, {
    ...payload,
    ...(context?.empresaId ? { _empresa_id: context.empresaId } : {}),
    ...(context?.slug ? { _slug: context.slug } : {}),
  });
}

export function verifyInboundSecret(headerVal: string | undefined): boolean {
  const expected = (
    process.env.N8N_INBOUND_SECRET ||
    process.env.N8N_WEBHOOK_SECRET ||
    ''
  ).trim();
  if (!expected) {
    return process.env.NODE_ENV !== 'production';
  }
  return String(headerVal || '').trim() === expected;
}

export function n8nStatus() {
  return {
    configured: n8nConfigured(),
    url_set: Boolean(n8nWebhookUrl()),
    enabled: String(process.env.N8N_ENABLED || '1'),
    secret_set: Boolean(process.env.N8N_WEBHOOK_SECRET?.trim()),
    inbound_secret_set: Boolean(
      process.env.N8N_INBOUND_SECRET?.trim() || process.env.N8N_WEBHOOK_SECRET?.trim()
    ),
  };
}
