/**
 * Integração n8n — saída (API → n8n) e status.
 *
 * Env:
 *   N8N_WEBHOOK_URL=https://seu-n8n.../webhook/filtra
 *   N8N_WEBHOOK_SECRET=opcional (header X-Filtra-Secret)
 *   N8N_TIMEOUT_MS=8000
 */

export type N8nEvent =
  | 'trial.activated'
  | 'review.critical'
  | 'review.created'
  | 'payment.activated'
  | 'lead.captured'
  | 'report.mensal'
  | 'ping';

export type N8nPingResult = {
  ok: boolean;
  configured: boolean;
  status?: number;
  detail: string;
};

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

function webhookHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Filtra.AI/1.0',
  };
  const secret = process.env.N8N_WEBHOOK_SECRET?.trim();
  if (secret) headers['X-Filtra-Secret'] = secret;
  return headers;
}

/**
 * Dispara evento para o n8n. Nunca lança — falhas só logam.
 */
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

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs());

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: webhookHeaders(),
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

/**
 * Ping explícito (POST) para diagnóstico no painel admin.
 * 404 do n8n = workflow inativo / path errado — NÃO é “URL ok”.
 */
export async function pingN8nWebhook(): Promise<N8nPingResult> {
  const url = process.env.N8N_WEBHOOK_URL?.trim();
  if (!url) {
    return {
      ok: false,
      configured: false,
      detail: 'N8N_WEBHOOK_URL não configurada no Render',
    };
  }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs());

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: webhookHeaders(),
      body: JSON.stringify({
        event: 'ping',
        source: 'filtra-ai',
        time: new Date().toISOString(),
        message: 'Filtra.AI connectivity check',
      }),
      signal: ac.signal,
    });
    const txt = await res.text().catch(() => '');

    if (res.ok) {
      return {
        ok: true,
        configured: true,
        status: res.status,
        detail: `Webhook OK (HTTP ${res.status})`,
      };
    }

    if (res.status === 404) {
      return {
        ok: false,
        configured: true,
        status: 404,
        detail:
          'HTTP 404 — workflow do n8n inativo ou path do webhook errado. Abra o n8n, ative o workflow (toggle) e use a URL de produção /webhook/...',
      };
    }

    return {
      ok: false,
      configured: true,
      status: res.status,
      detail: `HTTP ${res.status}: ${txt.slice(0, 120) || res.statusText}`,
    };
  } catch (e: any) {
    return {
      ok: false,
      configured: true,
      detail: e?.name === 'AbortError' ? 'Timeout ao contatar n8n' : e?.message || 'Falha de conexão',
    };
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
