/**
 * Integração n8n — essencial para captação e automações.
 *
 * Env:
 *   N8N_WEBHOOK_URL=https://seu-n8n.../webhook/filtra-ia
 *   N8N_WEBHOOK_SECRET=opcional (header X-Filtra-Secret)
 *   N8N_ENABLED=1  (default: liga se URL existir)
 *
 * Eventos enviados (JSON POST):
 *   trial.ativado | payment.confirmado | review.critica | lead.whatsapp
 */

export type N8nEvent =
  | 'trial.ativado'
  | 'payment.confirmado'
  | 'payment.cancelado'
  | 'review.critica'
  | 'review.nova'
  | 'lead.whatsapp'
  | 'empresa.bloqueada';

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

/**
 * Dispara o workflow n8n (fire-and-forget — não bloqueia a API).
 */
export function notifyN8n(
  event: N8nEvent,
  payload: Record<string, unknown>
): void {
  if (!n8nConfigured()) return;

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
  if (process.env.N8N_API_KEY?.trim()) {
    headers['X-N8N-API-KEY'] = process.env.N8N_API_KEY.trim();
  }

  // não await — captação não pode atrasar trial/pagamento
  fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  })
    .then(async (r) => {
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        console.warn(`[n8n] ${event} HTTP ${r.status}`, t.slice(0, 200));
      } else {
        console.log(`[n8n] ${event} ok`);
      }
    })
    .catch((e: any) => {
      console.warn(`[n8n] ${event} falhou:`, e?.message || e);
    });
}

export function n8nStatus() {
  return {
    configured: n8nConfigured(),
    url_set: Boolean(n8nWebhookUrl()),
    enabled: String(process.env.N8N_ENABLED || '1'),
  };
}
