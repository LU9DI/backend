/**
 * Mercado Pago — Pix avulso, agendado e assinatura recorrente.
 *
 * Env:
 *   MP_ACCESS_TOKEN=APP_USR-...   (produção) ou TEST-... (sandbox)
 *   MP_WEBHOOK_SECRET=           (opcional — x-signature)
 *   MP_NOTIFICATION_URL=         (opcional)
 *
 * NÃO use Public Key / Client ID aqui — só Access Token.
 */

import crypto from 'crypto';
import { resolvePlano, type PlanoDef } from '../stripeBilling.js';

const MP_API = 'https://api.mercadopago.com';

export type PixKind = 'avulso' | 'agendado' | 'recorrente';

export function mpConfigured(): boolean {
  return Boolean(process.env.MP_ACCESS_TOKEN?.trim());
}

/** Ambiente do token: live | test | unknown */
export function mpTokenMode(): 'live' | 'test' | 'unknown' {
  const t = process.env.MP_ACCESS_TOKEN?.trim() || '';
  if (t.startsWith('TEST-') || t.startsWith('TEST')) return 'test';
  if (t.startsWith('APP_USR-')) return 'live';
  return 'unknown';
}

function token(): string {
  const t = process.env.MP_ACCESS_TOKEN?.trim();
  if (!t) throw new Error('MP_ACCESS_TOKEN não configurado');
  // Public Key costuma começar com APP_USR- mas é curta / ou TEST- com "public"
  if (/public/i.test(t) || t.length < 40) {
    throw new Error(
      'MP_ACCESS_TOKEN parece inválido. Use o Access Token (não a Public Key). ' +
        'Painel MP → Seu negócio → Credenciais → Access Token.'
    );
  }
  return t;
}

function appUrl(): string {
  return (process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(
    /\/$/,
    ''
  );
}

function apiPublicUrl(): string {
  return (
    process.env.MP_NOTIFICATION_URL?.replace(/\/api\/webhook\/mercadopago\/?$/, '') ||
    process.env.API_PUBLIC_URL ||
    process.env.BACKEND_URL ||
    ''
  ).replace(/\/$/, '');
}

function notificationUrl(): string {
  if (process.env.MP_NOTIFICATION_URL?.trim()) {
    return process.env.MP_NOTIFICATION_URL.trim();
  }
  const base = apiPublicUrl();
  if (base) return `${base}/api/webhook/mercadopago`;
  // fallback produção Render
  if (process.env.NODE_ENV === 'production') {
    return 'https://filtra-ia-api.onrender.com/api/webhook/mercadopago';
  }
  return '';
}

export function planoAmountReais(plano: PlanoDef): number {
  return Number((plano.unitAmount / 100).toFixed(2));
}

function humanizeMpError(data: any, status: number): string {
  const raw =
    data?.message ||
    data?.error ||
    data?.cause?.[0]?.description ||
    data?.cause?.[0]?.message ||
    `Mercado Pago ${status}`;
  const msg = String(raw);

  if (/unauthorized use of live credentials/i.test(msg)) {
    return (
      'Mercado Pago recusou as credenciais (live). ' +
      'Você provavelmente colocou token de PRODUÇÃO (APP_USR-) em conta/app de teste, ' +
      'ou misturou Public Key com Access Token. ' +
      'Solução: no painel MP use Credenciais de produção → Access Token (APP_USR-...), ' +
      'ou para testes use o token TEST- da aplicação de teste. ' +
      'Nunca use a Public Key no backend.'
    );
  }
  if (/unauthorized|invalid.*token|invalid_token|401/i.test(msg)) {
    return (
      'Access Token do Mercado Pago inválido ou expirado. ' +
      'Gere um novo em Credenciais → Access Token e atualize MP_ACCESS_TOKEN no Render.'
    );
  }
  return msg;
}

async function mpFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${MP_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key':
        (init.headers as any)?.['X-Idempotency-Key'] ||
        `filtra-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = humanizeMpError(data, res.status);
    const err = new Error(msg) as Error & { status?: number; body?: any };
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export function buildExternalRef(opts: {
  empresaId?: string | null;
  planoKey: string;
  kind: PixKind;
}): string {
  return `filtra|${opts.kind}|${opts.planoKey}|${opts.empresaId || 'none'}|${Date.now()}`
    .slice(0, 200);
}

export function parseExternalRef(ref: string | null | undefined): {
  kind: PixKind | null;
  planoKey: string | null;
  empresaId: string | null;
} {
  if (!ref) return { kind: null, planoKey: null, empresaId: null };
  const parts = String(ref).split('|');
  if (parts[0] !== 'filtra' || parts.length < 4) {
    return { kind: null, planoKey: null, empresaId: null };
  }
  const kind = parts[1] as PixKind;
  const planoKey = parts[2] || null;
  const empresaId = parts[3] && parts[3] !== 'none' ? parts[3] : null;
  return { kind, planoKey, empresaId };
}

export async function createPixAvulso(opts: {
  planoKey: string;
  empresaId?: string | null;
  email?: string | null;
  nomePagador?: string | null;
  cpf?: string | null;
}): Promise<{
  paymentId: string;
  status: string;
  qrCode: string | null;
  qrCodeBase64: string | null;
  ticketUrl: string | null;
  amount: number;
  planoLabel: string;
  expiresAt: string | null;
  externalReference: string;
}> {
  const plano = resolvePlano(opts.planoKey);
  if (!plano) throw new Error('Plano inválido');

  const amount = planoAmountReais(plano);
  const external_reference = buildExternalRef({
    empresaId: opts.empresaId,
    planoKey: plano.key,
    kind: 'avulso',
  });

  const body: any = {
    transaction_amount: amount,
    description: `Filtra.IA — ${plano.label}`.slice(0, 250),
    payment_method_id: 'pix',
    external_reference,
    metadata: {
      empresa_id: opts.empresaId || '',
      plano: plano.key,
      plan_db: plano.planDb,
      kind: 'avulso',
    },
    payer: {
      email: opts.email || 'cliente@filtra.ia',
      first_name: (opts.nomePagador || 'Cliente').slice(0, 60),
    },
  };

  if (opts.cpf) {
    const cpf = String(opts.cpf).replace(/\D/g, '');
    if (cpf.length === 11) {
      body.payer.identification = { type: 'CPF', number: cpf };
    }
  }

  const notif = notificationUrl();
  if (notif) body.notification_url = notif;

  const data = await mpFetch('/v1/payments', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const poi = data.point_of_interaction?.transaction_data || {};
  return {
    paymentId: String(data.id),
    status: String(data.status || 'pending'),
    qrCode: poi.qr_code || null,
    qrCodeBase64: poi.qr_code_base64 || null,
    ticketUrl: poi.ticket_url || null,
    amount,
    planoLabel: plano.label,
    expiresAt: data.date_of_expiration || null,
    externalReference: external_reference,
  };
}

export async function createPixAgendado(opts: {
  planoKey: string;
  empresaId?: string | null;
  email?: string | null;
  venceEmIso: string;
  nomePagador?: string | null;
}): Promise<{
  paymentId: string;
  status: string;
  qrCode: string | null;
  qrCodeBase64: string | null;
  ticketUrl: string | null;
  amount: number;
  planoLabel: string;
  expiresAt: string | null;
  externalReference: string;
}> {
  const plano = resolvePlano(opts.planoKey);
  if (!plano) throw new Error('Plano inválido');

  const amount = planoAmountReais(plano);
  const external_reference = buildExternalRef({
    empresaId: opts.empresaId,
    planoKey: plano.key,
    kind: 'agendado',
  });

  const vence = new Date(opts.venceEmIso);
  if (Number.isNaN(vence.getTime())) throw new Error('Data de vencimento inválida');
  const max = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000);
  if (vence.getTime() > max.getTime()) {
    throw new Error('Vencimento do Pix agendado deve ser em até 29 dias');
  }
  if (vence.getTime() < Date.now() + 60_000) {
    throw new Error('Vencimento deve ser no futuro');
  }

  const body: any = {
    transaction_amount: amount,
    description: `Filtra.IA — ${plano.label} (agendado)`.slice(0, 250),
    payment_method_id: 'pix',
    date_of_expiration: vence.toISOString(),
    external_reference,
    metadata: {
      empresa_id: opts.empresaId || '',
      plano: plano.key,
      plan_db: plano.planDb,
      kind: 'agendado',
    },
    payer: {
      email: opts.email || 'cliente@filtra.ia',
      first_name: (opts.nomePagador || 'Cliente').slice(0, 60),
    },
  };

  const notif = notificationUrl();
  if (notif) body.notification_url = notif;

  const data = await mpFetch('/v1/payments', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const poi = data.point_of_interaction?.transaction_data || {};
  return {
    paymentId: String(data.id),
    status: String(data.status || 'pending'),
    qrCode: poi.qr_code || null,
    qrCodeBase64: poi.qr_code_base64 || null,
    ticketUrl: poi.ticket_url || null,
    amount,
    planoLabel: plano.label,
    expiresAt: data.date_of_expiration || null,
    externalReference: external_reference,
  };
}

export async function createPixRecorrente(opts: {
  planoKey: string;
  empresaId?: string | null;
  email?: string | null;
  reason?: string;
}): Promise<{
  preapprovalId: string;
  initPoint: string;
  status: string;
  amount: number;
  planoLabel: string;
  frequency: number;
  frequencyType: string;
  externalReference: string;
}> {
  const plano = resolvePlano(opts.planoKey);
  if (!plano) throw new Error('Plano inválido');

  const amount = planoAmountReais(plano);
  const external_reference = buildExternalRef({
    empresaId: opts.empresaId,
    planoKey: plano.key,
    kind: 'recorrente',
  });

  const frequency = plano.interval === 'year' ? 12 : 1;
  const frequency_type = 'months';

  const body: any = {
    reason: (opts.reason || `Filtra.IA — ${plano.label}`).slice(0, 250),
    external_reference,
    payer_email: opts.email || undefined,
    auto_recurring: {
      frequency,
      frequency_type,
      transaction_amount: amount,
      currency_id: 'BRL',
    },
    back_url: `${appUrl()}/?pix=recurring_return&empresa_id=${encodeURIComponent(opts.empresaId || '')}&plano=${encodeURIComponent(plano.key)}`,
    status: 'pending',
    metadata: {
      empresa_id: opts.empresaId || '',
      plano: plano.key,
      plan_db: plano.planDb,
      kind: 'recorrente',
    },
  };

  const data = await mpFetch('/preapproval', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const init =
    data.init_point ||
    data.sandbox_init_point ||
    data.auto_recurring?.init_point ||
    null;
  if (!init) throw new Error('Mercado Pago não retornou init_point da assinatura');

  return {
    preapprovalId: String(data.id),
    initPoint: String(init),
    status: String(data.status || 'pending'),
    amount,
    planoLabel: plano.label,
    frequency,
    frequencyType: frequency_type,
    externalReference: external_reference,
  };
}

export async function getPayment(paymentId: string): Promise<any> {
  return mpFetch(`/v1/payments/${paymentId}`, { method: 'GET' });
}

export async function getPreapproval(id: string): Promise<any> {
  return mpFetch(`/preapproval/${id}`, { method: 'GET' });
}

export function verifyMpWebhookSignature(opts: {
  xSignature?: string | null;
  xRequestId?: string | null;
  dataId?: string | null;
}): boolean {
  const secret = process.env.MP_WEBHOOK_SECRET?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[mp webhook] MP_WEBHOOK_SECRET ausente em produção');
      return false;
    }
    return true;
  }
  const sig = opts.xSignature || '';
  const parts: Record<string, string> = {};
  for (const p of sig.split(',')) {
    const [k, v] = p.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1 || !opts.dataId || !opts.xRequestId) return false;

  const manifest = `id:${opts.dataId};request-id:${opts.xRequestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
  } catch {
    return expected === v1;
  }
}
