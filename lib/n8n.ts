/**
 * Integração n8n — saída (API → n8n) e status.
 *
 * Env gerais:
 *   N8N_WEBHOOK_URL=https://seu-n8n.../webhook/filtra
 *   N8N_WEBHOOK_SECRET=opcional (header X-Filtra-Secret)
 *   N8N_TIMEOUT_MS=8000
 *
 * Relatório mensal (preferencial):
 *   N8N_WHATSAPP_REPORT_URL=https://seu-n8n.../webhook/filtra-relatorio
 *   N8N_WHATSAPP_REPORT_TOKEN=Bearer opcional
 *
 * Se N8N_WHATSAPP_REPORT_URL não existir, usa N8N_WEBHOOK_URL.
 */

export type N8nEvent =
  | 'trial.activated'
  | 'review.critical'
  | 'review.created'
  | 'payment.activated'
  | 'payment.confirmado'
  | 'lead.captured'
  | 'relatorio.mensal'
  | 'ping';

export function n8nConfigured(): boolean {
  return Boolean(
    process.env.N8N_WHATSAPP_REPORT_URL?.trim() || process.env.N8N_WEBHOOK_URL?.trim()
  );
}

export function n8nReportUrl(): string | null {
  return (
    process.env.N8N_WHATSAPP_REPORT_URL?.trim() ||
    process.env.N8N_WEBHOOK_URL?.trim() ||
    null
  );
}

export function n8nStatus() {
  return {
    configured: n8nConfigured(),
    url_set: Boolean(process.env.N8N_WEBHOOK_URL?.trim()),
    report_url_set: Boolean(process.env.N8N_WHATSAPP_REPORT_URL?.trim()),
    secret_set: Boolean(process.env.N8N_WEBHOOK_SECRET?.trim()),
    report_token_set: Boolean(process.env.N8N_WHATSAPP_REPORT_TOKEN?.trim()),
    inbound_secret_set: Boolean(
      process.env.N8N_INBOUND_SECRET?.trim() || process.env.N8N_WEBHOOK_SECRET?.trim()
    ),
  };
}

function timeoutMs(): number {
  return Math.max(2000, Number(process.env.N8N_TIMEOUT_MS || 10000));
}

/**
 * Chave estável: 1 relatório por empresa + período.
 * O n8n deve gravar e ignorar duplicatas com a mesma chave.
 */
export function reportIdempotencyKey(clienteId: string, periodoChave: string): string {
  return `relatorio:${String(clienteId)}:${String(periodoChave)}`;
}

/**
 * Dispara evento genérico para o n8n. Nunca lança — falhas só logam.
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

/**
 * Envia o payload do relatório mensal para o webhook dedicado (ou genérico).
 * Retorna true só se HTTP 2xx — job NÃO marca como enviado se false.
 */
export async function dispatchReportToN8n(
  payload: Record<string, unknown>
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const url = n8nReportUrl();
  if (!url) return { ok: false, error: 'N8N_URL_NOT_SET' };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Filtra.AI/report-job',
  };
  const token = process.env.N8N_WHATSAPP_REPORT_TOKEN?.trim();
  if (token) {
    headers.Authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
  }
  const secret = process.env.N8N_WEBHOOK_SECRET?.trim();
  if (secret) headers['X-Filtra-Secret'] = secret;

  // idempotency no header para n8n / proxies que leem header
  const key = payload.idempotency_key;
  if (key) headers['Idempotency-Key'] = String(key);

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs());

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        event: 'relatorio.mensal',
        source: 'filtra-ai',
        time: new Date().toISOString(),
        ...payload,
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.warn(`[n8n] relatorio.mensal HTTP ${res.status}: ${txt.slice(0, 160)}`);
      return { ok: false, status: res.status, error: txt.slice(0, 200) };
    }
    return { ok: true, status: res.status };
  } catch (e: any) {
    console.warn('[n8n] relatorio.mensal fail:', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
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
