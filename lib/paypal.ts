/**
 * PayPal Checkout (Orders v2) + Webhooks.
 *
 * Env:
 *   PAYPAL_CLIENT_ID=
 *   PAYPAL_CLIENT_SECRET=
 *   PAYPAL_MODE=sandbox|live
 *   PAYPAL_WEBHOOK_ID=   (ID do webhook no Developer Dashboard)
 */
import { resolvePlano, type PlanoDef } from '../stripeBilling.js';

function baseUrl(): string {
  const mode = (process.env.PAYPAL_MODE || 'sandbox').toLowerCase();
  return mode === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

export function paypalConfigured(): boolean {
  return Boolean(
    process.env.PAYPAL_CLIENT_ID?.trim() && process.env.PAYPAL_CLIENT_SECRET?.trim()
  );
}

export function paypalWebhookConfigured(): boolean {
  return paypalConfigured() && Boolean(process.env.PAYPAL_WEBHOOK_ID?.trim());
}

async function accessToken(): Promise<string> {
  const id = process.env.PAYPAL_CLIENT_ID!.trim();
  const secret = process.env.PAYPAL_CLIENT_SECRET!.trim();
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch(`${baseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data?.error_description || data?.error || 'PayPal OAuth falhou');
  }
  return data.access_token as string;
}

function appUrl(): string {
  return (process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(
    /\/$/,
    ''
  );
}

export function planoAmountBrl(plano: PlanoDef): string {
  return (plano.unitAmount / 100).toFixed(2);
}

/** custom_id: empresaId|planoKey (limite ~127 chars). */
export function buildCustomId(empresaId: string | null | undefined, planoKey: string): string {
  const eid = String(empresaId || '').slice(0, 60);
  const pk = String(planoKey || '').slice(0, 40);
  return `${eid}|${pk}`.slice(0, 127);
}

export function parseCustomId(customId: string | null | undefined): {
  empresaId: string | null;
  planoKey: string | null;
} {
  if (!customId) return { empresaId: null, planoKey: null };
  const parts = String(customId).split('|');
  if (parts.length >= 2) {
    return {
      empresaId: parts[0] || null,
      planoKey: parts.slice(1).join('|') || null,
    };
  }
  // só empresa id (legado)
  return { empresaId: String(customId), planoKey: null };
}

export function parsePlanoFromInvoiceId(invoiceId: string | null | undefined): string | null {
  if (!invoiceId) return null;
  // filtra-{planoKey}-{timestamp}
  const m = String(invoiceId).match(/^filtra-([a-z0-9-]+)-\d+$/i);
  return m ? m[1] : null;
}

export async function createPayPalOrder(opts: {
  planoKey: string;
  empresaId?: string | null;
  email?: string | null;
}): Promise<{ orderId: string; approveUrl: string; label: string; value: number }> {
  if (!paypalConfigured()) throw new Error('PayPal não configurado');
  const plano = resolvePlano(opts.planoKey);
  if (!plano) throw new Error('Plano inválido');

  const token = await accessToken();
  const value = planoAmountBrl(plano);
  const returnUrl = `${appUrl()}/?paypal=success&empresa_id=${encodeURIComponent(opts.empresaId || '')}&plano=${encodeURIComponent(plano.key)}&order_id=`;
  const cancelUrl = `${appUrl()}/?paypal=cancel`;

  const body = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        amount: {
          currency_code: 'BRL',
          value,
        },
        description: `Filtra.IA — ${plano.label}`.slice(0, 127),
        custom_id: buildCustomId(opts.empresaId, plano.key),
        invoice_id: `filtra-${plano.key}-${Date.now()}`.slice(0, 127),
      },
    ],
    application_context: {
      brand_name: 'Filtra.IA',
      landing_page: 'NO_PREFERENCE',
      user_action: 'PAY_NOW',
      return_url: returnUrl,
      cancel_url: cancelUrl,
    },
  };

  const res = await fetch(`${baseUrl()}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const details = Array.isArray(data?.details)
      ? data.details.map((item: any) => ({
          field: item?.field,
          issue: item?.issue,
          description: item?.description,
          location: item?.location,
        }))
      : [];
    const message =
      data?.message || data?.details?.[0]?.description || `PayPal ${res.status}`;
    const error = new Error(message);
    (error as any).status = res.status;
    (error as any).body = {
      provider: 'paypal',
      name: data?.name || null,
      debug_id: data?.debug_id || null,
      details,
    };
    throw error;
  }

  const approve = (data.links || []).find((l: any) => l.rel === 'approve');
  if (!approve?.href) throw new Error('PayPal não retornou link de aprovação');

  return {
    orderId: data.id,
    approveUrl: approve.href,
    label: plano.label,
    value: plano.displayMonthly,
  };
}

export async function capturePayPalOrder(orderId: string): Promise<{
  status: string;
  captureId?: string;
  amount?: string;
  customId?: string | null;
  invoiceId?: string | null;
  orderId: string;
}> {
  if (!paypalConfigured()) throw new Error('PayPal não configurado');
  const token = await accessToken();
  const res = await fetch(`${baseUrl()}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  const data = await res.json();
  if (!res.ok) {
    // já capturado — tenta GET
    if (res.status === 422 || String(data?.name || '').includes('ORDER_ALREADY_CAPTURED')) {
      return getPayPalOrderSummary(orderId);
    }
    throw new Error(data?.message || data?.details?.[0]?.description || `Capture ${res.status}`);
  }

  const unit = data?.purchase_units?.[0];
  const cap = unit?.payments?.captures?.[0];
  return {
    status: data.status || cap?.status || 'UNKNOWN',
    captureId: cap?.id,
    amount: cap?.amount?.value,
    customId: unit?.custom_id || null,
    invoiceId: unit?.invoice_id || null,
    orderId: data.id || orderId,
  };
}

export async function getPayPalOrderSummary(orderId: string) {
  const token = await accessToken();
  const res = await fetch(`${baseUrl()}/v2/checkout/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `GET order ${res.status}`);
  const unit = data?.purchase_units?.[0];
  const cap = unit?.payments?.captures?.[0];
  return {
    status: data.status || cap?.status || 'UNKNOWN',
    captureId: cap?.id,
    amount: cap?.amount?.value,
    customId: unit?.custom_id || null,
    invoiceId: unit?.invoice_id || null,
    orderId: data.id || orderId,
  };
}

/** Verifica autenticidade do webhook via API PayPal. */
export async function verifyPayPalWebhook(opts: {
  headers: Record<string, string | string[] | undefined>;
  webhookEvent: any;
}): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID?.trim();
  if (!webhookId) {
    // em dev sem webhook id, aceita se não for production
    if (process.env.NODE_ENV === 'production') {
      throw new Error('PAYPAL_WEBHOOK_ID obrigatório em produção');
    }
    console.warn('[paypal webhook] PAYPAL_WEBHOOK_ID ausente — skip verify (dev)');
    return true;
  }

  const h = opts.headers;
  const get = (k: string) => {
    const v = h[k] || h[k.toLowerCase()] || h[k.toUpperCase()];
    return Array.isArray(v) ? v[0] : v;
  };

  const transmission_id = get('paypal-transmission-id');
  const transmission_time = get('paypal-transmission-time');
  const cert_url = get('paypal-cert-url');
  const auth_algo = get('paypal-auth-algo');
  const transmission_sig = get('paypal-transmission-sig');

  if (!transmission_id || !transmission_time || !cert_url || !auth_algo || !transmission_sig) {
    throw new Error('Headers PayPal incompletos');
  }

  const token = await accessToken();
  const res = await fetch(`${baseUrl()}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      transmission_id,
      transmission_time,
      cert_url,
      auth_algo,
      transmission_sig,
      webhook_id: webhookId,
      webhook_event: opts.webhookEvent,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('[paypal verify]', data);
    return false;
  }
  return String(data.verification_status || '').toUpperCase() === 'SUCCESS';
}
