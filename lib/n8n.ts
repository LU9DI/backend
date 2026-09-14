/**
 * Integração n8n — saída (API → n8n) e status.
 *
 * Env:
 *   N8N_WEBHOOK_URL=https://seu-n8n.../webhook/filtra
 *   N8N_WEBHOOK_SECRET=segredo compartilhado
 *   N8N_TIMEOUT_MS=8000
 */

export type N8nEvent =
  | 'trial.activated'
  | 'review.critical'
  | 'review.created'
  | 'payment.activated'
  | 'lead.captured'
  | 'report.generated'
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

/** Dispara evento para o n8n sem bloquear a operação principal. */
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
  if (secret) {
    // Mantém os dois nomes para compatibilidade com o workflow já testado.
    headers['X-Filtra-Secret'] = secret;
    headers['x-filtra-report-token'] = secret;
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
  if (!expected) {
    return process.env.NODE_ENV !== 'production';
  }
  return String(headerVal || '').trim() === expected;
}
