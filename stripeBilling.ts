/**
 * Stripe Checkout — planos do produto atual (Pro / Ultra / Corporativo).
 * Não altera regras de trial, PDF ou IA; só cobrança e ativação via webhook.
 */
import crypto from 'crypto';

const STRIPE_API = 'https://api.stripe.com/v1';

export type PlanoKey = 'pro' | 'pro-anual' | 'ultra' | 'corporate' | 'corporativo';

export type PlanoDef = {
  key: PlanoKey;
  planDb: 'pro' | 'ultra' | 'corporate';
  label: string;
  unitAmount: number;
  interval: 'month' | 'year';
  reviewLimit: number;
  envPriceId?: string;
};

export const PLANOS: Record<string, PlanoDef> = {
  pro: {
    key: 'pro',
    planDb: 'pro',
    label: 'Pro Mensal',
    unitAmount: 6990,
    interval: 'month',
    reviewLimit: 150,
    envPriceId: process.env.STRIPE_PRICE_PRO_MONTHLY,
  },
  'pro-anual': {
    key: 'pro-anual',
    planDb: 'pro',
    label: 'Pro Anual',
    unitAmount: 4990 * 12,
    interval: 'year',
    reviewLimit: 150,
    envPriceId: process.env.STRIPE_PRICE_PRO_YEARLY,
  },
  ultra: {
    key: 'ultra',
    planDb: 'ultra',
    label: 'Ultra',
    unitAmount: 19990,
    interval: 'month',
    reviewLimit: 1000,
    envPriceId: process.env.STRIPE_PRICE_ULTRA,
  },
  corporate: {
    key: 'corporate',
    planDb: 'corporate',
    label: 'Corporativo',
    unitAmount: 49990,
    interval: 'month',
    reviewLimit: Number.MAX_SAFE_INTEGER,
    envPriceId: process.env.STRIPE_PRICE_CORPORATE,
  },
  corporativo: {
    key: 'corporativo',
    planDb: 'corporate',
    label: 'Corporativo',
    unitAmount: 49990,
    interval: 'month',
    reviewLimit: Number.MAX_SAFE_INTEGER,
    envPriceId: process.env.STRIPE_PRICE_CORPORATE,
  },
};

export function resolvePlano(raw: string): PlanoDef | null {
  const k = String(raw || '')
    .toLowerCase()
    .trim();
  return PLANOS[k] || null;
}

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

export function stripeWebhookSecret(): string {
  return process.env.STRIPE_WEBHOOK_SECRET || '';
}

function appUrl(): string {
  return (process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(
    /\/$/,
    ''
  );
}

async function stripeForm(path: string, params: Record<string, string>): Promise<any> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY não configurada');

  const body = new URLSearchParams(params);
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Stripe ${res.status}`);
  }
  return data;
}

export async function criarCheckoutSession(opts: {
  planoKey: string;
  empresaId?: string | null;
  email?: string | null;
  nomeEmpresa?: string | null;
}): Promise<{ sessionId: string; checkoutUrl: string; label: string; value: number }> {
  const plano = resolvePlano(opts.planoKey);
  if (!plano) throw new Error('Plano inválido');

  const success = `${appUrl()}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancel = `${appUrl()}/?checkout=cancel`;

  const params: Record<string, string> = {
    mode: 'subscription',
    success_url: success,
    cancel_url: cancel,
    'metadata[plano]': plano.key,
    'metadata[plan_db]': plano.planDb,
    'subscription_data[metadata][plano]': plano.key,
    'subscription_data[metadata][plan_db]': plano.planDb,
    allow_promotion_codes: 'true',
  };

  if (opts.empresaId) {
    params['metadata[empresa_id]'] = opts.empresaId;
    params['client_reference_id'] = opts.empresaId;
    params['subscription_data[metadata][empresa_id]'] = opts.empresaId;
  }
  if (opts.email) params['customer_email'] = opts.email;
  if (opts.nomeEmpresa) params['metadata[nome_empresa]'] = String(opts.nomeEmpresa).slice(0, 120);

  if (plano.envPriceId) {
    params['line_items[0][price]'] = plano.envPriceId;
    params['line_items[0][quantity]'] = '1';
  } else {
    params['line_items[0][price_data][currency]'] = 'brl';
    params['line_items[0][price_data][unit_amount]'] = String(plano.unitAmount);
    params['line_items[0][price_data][recurring][interval]'] = plano.interval;
    params['line_items[0][price_data][product_data][name]'] = `Filtra.IA — ${plano.label}`;
    params['line_items[0][quantity]'] = '1';
  }

  const session = await stripeForm('/checkout/sessions', params);
  if (!session.url) throw new Error('Stripe não retornou URL de checkout');

  return {
    sessionId: session.id,
    checkoutUrl: session.url,
    label: plano.label,
    value: plano.unitAmount / 100,
  };
}

/** Customer Portal — cartão, faturas e cancelamento (no fim do ciclo). */
export async function criarPortalSession(customerId: string): Promise<{ url: string }> {
  const session = await stripeForm('/billing_portal/sessions', {
    customer: customerId,
    return_url: `${appUrl()}/`,
  });
  if (!session.url) throw new Error('Stripe não retornou URL do portal');
  return { url: session.url };
}

export function constructStripeEvent(rawBody: Buffer | string, signature: string | undefined): any {
  const secret = stripeWebhookSecret();
  const isProd = process.env.NODE_ENV === 'production';

  if (!secret) {
    if (isProd) throw new Error('STRIPE_WEBHOOK_SECRET obrigatório em produção');
    const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    return JSON.parse(text);
  }
  if (!signature) throw new Error('Assinatura Stripe ausente');

  const elements = signature.split(',').map((p) => p.trim());
  let timestamp = '';
  const signatures: string[] = [];
  for (const el of elements) {
    const [k, v] = el.split('=');
    if (k === 't') timestamp = v;
    if (k === 'v1') signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) throw new Error('Assinatura Stripe inválida');

  const payload =
    `${timestamp}.` + (typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
  const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  const ok = signatures.some((sig) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  });
  if (!ok) throw new Error('Falha na verificação da assinatura Stripe');

  const ts = Number(timestamp);
  if (Math.abs(Date.now() / 1000 - ts) > 300) throw new Error('Timestamp Stripe expirado');

  const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  return JSON.parse(text);
}

export function extractFromStripeObject(obj: any): {
  empresaId: string | null;
  planDb: string | null;
  customerId: string | null;
  subscriptionId: string | null;
} {
  const meta = obj?.metadata || {};
  const empresaId =
    meta.empresa_id ||
    obj?.client_reference_id ||
    obj?.subscription_details?.metadata?.empresa_id ||
    null;
  const planDb = meta.plan_db || meta.plano || null;
  return {
    empresaId: empresaId ? String(empresaId) : null,
    planDb: planDb ? String(planDb) : null,
    customerId: obj?.customer ? String(obj.customer) : null,
    subscriptionId: obj?.subscription
      ? String(obj.subscription)
      : obj?.id && String(obj.object) === 'subscription'
        ? String(obj.id)
        : null,
  };
}

export function listPlanosPublicos() {
  return ['pro', 'pro-anual', 'ultra', 'corporate'].map((k) => {
    const p = PLANOS[k];
    return {
      key: p.key,
      label: p.label,
      value: p.unitAmount / 100,
      interval: p.interval,
      reviewLimit: p.reviewLimit === Number.MAX_SAFE_INTEGER ? null : p.reviewLimit,
    };
  });
}
