/** Integração n8n — saída e status. */

export type N8nEvent =
  | 'trial.activated'
  | 'review.critical'
  | 'review.created'
  | 'payment.activated'
  | 'lead.captured'
  | 'ping';

export function n8nConfigured(): boolean {
  return Boolean(process.env.N8N_WEBHOOK_URL?.trim());
}

export function n8nStatus() {
  return {
    configured: n8nConfigured(),
    url_set: Boolean(process.env.N8N_WEBHOOK_URL?.trim()),
    secret_set: Boolean(process.env.N8N_WEBHOOK_SECRET?.trim()),
    inbound_secret_set: Boolean(
      process.env.N8N_INBOUND_SECRET?.trim() || process.env.N8N_WEBHOOK_SECRET?.trim()
    ),
  };
}

function timeoutMs(): number {
  return Math.max(2000, Number(process.env.N8N_TIMEOUT_MS || 8000));
}

export async function notifyN8n(
  event: N8nEvent | string,
  payload: Record<string, unknown> = {}
): Promise<boolean> {
  const url = process.env.N8N_WEBHOOK_URL?.trim();
  if (!url) return false;

  const body = {
    event,
    source: 'filtra-ai',
    time: new Date().toISOString(),
    ...payload,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Filtra.AI/1.0',
  };
  const secret = process.env.N8N_WEBHOOK_SECRET?.trim();
  if (secret) headers['X-Filtra-Secret'] = secret;

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
  return notifyN8n(event, {
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
  if (!expected) return process.env.NODE_ENV !== 'production';
  return String(headerVal || '').trim() === expected;
}
