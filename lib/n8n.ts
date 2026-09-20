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

export type N8nEvent =
  | 'trial.ativado'
  | 'payment.confirmado'
  | 'payment.cancelado'
  | 'review.critica'
  | 'review.nova'
  | 'lead.whatsapp'
  | 'lead.captured'
  | 'empresa.bloqueada'
  | 'lead.qualified'
  | 'lead.followup.requested'
  | 'lead.crm_sync.requested'
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

export async function sendN8nWebhook(
  event: N8nEvent | string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  if (!n8nConfigured()) throw new Error('n8n não configurado');

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
  if (process.env.N8N_API_KEY?.trim()) headers['X-N8N-API-KEY'] = process.env.N8N_API_KEY.trim();

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs());
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    console.log(`[n8n] ${event} ok`);
  } finally {
    clearTimeout(t);
  }
}

export async function queueN8nEvent(
  event: N8nEvent | string,
  payload: Record<string, unknown> = {},
  options: { dedupeKey?: string | null; delayMs?: number } = {}
): Promise<number | null> {
  if (!n8nConfigured()) return null;
  const { enqueueRetry } = await import('./retryQueue.js');
  const id = await enqueueRetry({
    jobType: 'n8n_webhook',
    payload: { event, payload },
    dedupeKey: options.dedupeKey ?? null,
    delayMs: options.delayMs,
  });
  console.log(`[n8n] ${event} queued job=${id}`);
  return id;
}

export function notifyN8n(
  event: N8nEvent | string,
  payload: Record<string, unknown> = {}
): void {
  if (!n8nConfigured()) return;
  queueN8nEvent(event, payload).catch((e) =>
    console.warn(`[n8n] ${event} queue failed:`, e?.message || e)
  );
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

  const ac = new AbortController;
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
