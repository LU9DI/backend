/**
 * Integração n8n — saída (API → n8n) e status.
 *
 * Env:
 *   N8N_WEBHOOK_URL=https://seu-n8n.../webhook/filtra
 *   N8N_WEBHOOK_SECRET=segredo compartilhado
 *   N8N_TIMEOUT_MS=8000
 *   N8N_ENABLED=1
 */

export type N8nEvent =
  | 'trial.activated'
  | 'trial.ativado'
  | 'review.critical'
  | 'review.created'
  | 'payment.activated'
  | 'lead.captured'
  | 'report.generated'
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

function timeoutMs(): number {
  return Math.max(2000, Number(process.env.N8N_TIMEOUT_MS || 8000));
}

/** Dispara evento para o n8n (async, retorna sucesso). */
export async function notifyN8n(
  event: N8nEvent | string,
  payload: Record<string, unknown> = {}
): Promise<boolean> {
  return notifyN8nAsync(event, payload);
}

/** Alias usado por relatorioRoutes e n8nRoutes. */
export async function notifyN8nAsync(
  event: N8nEvent | string,
  payload: Record<string, unknown> = {}
): Promise<boolean> {
  if (!n8nConfigured()) return false;

  const url = n8nWebhookUrl();
  const body = {
    event,
    source: 'filtra-ai',
    time: new Date().toISOString(),
    ts: new Date().toISOString(),
    ...payload,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Filtra.AI/1.0',
  };
  const secret = process.env.N8N_WEBHOOK_SECRET?.trim();
  if (secret) {
    headers['X-Filtra-Secret'] = secret;
    headers['x-filtra-report-token'] = secret;
  }
  if (process.env.N8N_API_KEY?.trim()) {
    headers['X-N8N-API-KEY'] = process.env.N8N_API_KEY.trim();
  }

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

/** Alias usado pelos hooks internos. */
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
