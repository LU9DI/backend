/**
 * Handlers registrados na fila de retry.
 */
import { registerRetryHandler } from './retryQueue.js';
import { getDb } from './db.js';
import {
  capturePayPalOrder,
  parseCustomId,
  parsePlanoFromInvoiceId,
  getPayPalOrderSummary,
} from './paypal.js';
import {
  getPayment,
  getPreapproval,
  parseExternalRef,
  mpConfigured,
} from './mercadopago.js';
import { resolvePlano } from '../stripeBilling.js';
import { activatePlan, blockEmpresa } from '../services/billingService.js';
import { enviarEmail } from './mailer.js';
import { logWebhookEvent } from './opsLog.js';
import { sendN8nWebhook } from './n8n.js';
import { processAcquisitionEmail } from './acquisitionEngine.js';
import { enviarEmail } from './mailer.js';

async function activatePayPal(
  empresaId: string,
  planoKey: string | null,
  captureId?: string | null,
  orderId?: string | null
) {
  const db = getDb();
  const plano = resolvePlano(planoKey || 'pro');
  const days = plano?.interval === 'year' ? 365 : 30;
  const exp = new Date();
  exp.setDate(exp.getDate() + days);
  await activatePlan(
    db,
    empresaId,
    plano?.planDb || 'pro',
    null,
    `paypal:${captureId || orderId || 'retry'}`,
    exp.toISOString()
  );
  try {
    const cols = (await db.all(`PRAGMA table_info(empresas)`)).map((c: any) => c.name);
    if (!cols.includes('payment_gateway')) {
      await db.exec(`ALTER TABLE empresas ADD COLUMN payment_gateway TEXT`);
    }
    if (!cols.includes('billing_cycle')) {
      await db.exec(`ALTER TABLE empresas ADD COLUMN billing_cycle TEXT`);
    }
    await db.run(`UPDATE empresas SET payment_gateway = 'paypal', billing_cycle = ? WHERE id = ?`, [
      plano?.interval === 'year' ? 'year' : 'month',
      empresaId,
    ]);
  } catch {
    /* */
  }
}

async function activateFromMp(
  empresaId: string,
  planoKey: string | null,
  paymentId?: string | null,
  preapprovalId?: string | null
) {
  const db = getDb();
  const plano = resolvePlano(planoKey || 'pro');
  const days = plano?.interval === 'year' ? 365 : 30;
  const exp = new Date();
  exp.setDate(exp.getDate() + days);
  await activatePlan(
    db,
    empresaId,
    plano?.planDb || 'pro',
    null,
    preapprovalId
      ? `mp_preapproval:${preapprovalId}`
      : paymentId
        ? `mp_pix:${paymentId}`
        : `mp_pix:retry`,
    exp.toISOString()
  );
  try {
    const cols = (await db.all(`PRAGMA table_info(empresas)`)).map((c: any) => c.name);
    if (!cols.includes('payment_gateway')) {
      await db.exec(`ALTER TABLE empresas ADD COLUMN payment_gateway TEXT`);
    }
    if (!cols.includes('billing_cycle')) {
      await db.exec(`ALTER TABLE empresas ADD COLUMN billing_cycle TEXT`);
    }
    if (!cols.includes('mp_preapproval_id')) {
      await db.exec(`ALTER TABLE empresas ADD COLUMN mp_preapproval_id TEXT`);
    }
    await db.run(
      `UPDATE empresas SET payment_gateway = 'mercadopago_pix', billing_cycle = ? WHERE id = ?`,
      [plano?.interval === 'year' ? 'year' : 'month', empresaId]
    );
    if (preapprovalId) {
      await db.run(`UPDATE empresas SET mp_preapproval_id = ? WHERE id = ?`, [
        preapprovalId,
        empresaId,
      ]);
    }
  } catch {
    /* */
  }
}

export function registerAllRetryHandlers() {
  registerRetryHandler('paypal_webhook', async (payload) => {
    const eventType = String(payload.event_type || '');
    const resource = payload.resource || {};

    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      let customId = resource.custom_id || null;
      let orderId = resource.supplementary_data?.related_ids?.order_id || null;
      let invoiceId = resource.invoice_id || null;
      const captureId = resource.id || null;

      if (orderId && (!customId || !invoiceId)) {
        const order = await getPayPalOrderSummary(String(orderId));
        customId = customId || order.customId;
        invoiceId = invoiceId || order.invoiceId;
      }

      const parsed = parseCustomId(customId);
      const planoKey = parsed.planoKey || parsePlanoFromInvoiceId(invoiceId);
      if (!parsed.empresaId) throw new Error('paypal_webhook: empresa_id ausente no retry');
      await activatePayPal(parsed.empresaId, planoKey, captureId, orderId);
      return;
    }

    if (
      eventType === 'CHECKOUT.ORDER.APPROVED' ||
      eventType === 'CHECKOUT.ORDER.COMPLETED'
    ) {
      const orderId = resource.id;
      if (!orderId) throw new Error('order id ausente');
      const cap = await capturePayPalOrder(String(orderId));
      const parsed = parseCustomId(cap.customId);
      if (!parsed.empresaId) throw new Error('empresa ausente após capture');
      await activatePayPal(
        parsed.empresaId,
        parsed.planoKey || parsePlanoFromInvoiceId(cap.invoiceId),
        cap.captureId,
        String(orderId)
      );
      return;
    }

    if (
      eventType === 'PAYMENT.CAPTURE.REFUNDED' ||
      eventType === 'PAYMENT.CAPTURE.REVERSED'
    ) {
      const parsed = parseCustomId(resource.custom_id);
      let empresaId = parsed.empresaId;
      if (!empresaId && resource.id) {
        const row = await getDb().get(
          `SELECT id FROM empresas WHERE stripe_subscription_id = ?`,
          [`paypal:${resource.id}`]
        );
        empresaId = row?.id || null;
      }
      if (!empresaId) throw new Error('refund sem empresa');
      await blockEmpresa(getDb(), empresaId, { notify: true, tipo: 'assinatura' });
      return;
    }
  });

  registerRetryHandler('capture_paypal', async (payload) => {
    const orderId = String(payload.order_id || '');
    if (!orderId) throw new Error('order_id obrigatório');
    const cap = await capturePayPalOrder(orderId);
    const parsed = parseCustomId(cap.customId || payload.custom_id);
    const empresaId = parsed.empresaId || payload.empresa_id;
    if (!empresaId) throw new Error('empresa_id ausente');
    await activatePayPal(
      String(empresaId),
      parsed.planoKey || payload.plano || parsePlanoFromInvoiceId(cap.invoiceId),
      cap.captureId,
      orderId
    );
  });

  /** Reprocessa webhook Mercado Pago (payment / preapproval). */
  registerRetryHandler('mp_webhook', async (payload) => {
    if (!mpConfigured()) throw new Error('MP_ACCESS_TOKEN ausente');
    const body = payload.body || payload;
    const query = payload.query || {};
    const type = String(body.type || body.action || body.topic || query.topic || '');
    const dataId = String(
      body.data?.id || body.id || query.id || body['data.id'] || ''
    ).trim();

    if (type.includes('preapproval') || type.includes('subscription') || String(query.topic || '').includes('subscription')) {
      const preId = dataId || String(query.id || '');
      if (!preId) throw new Error('mp_webhook: preapproval id ausente');
      const remote = await getPreapproval(preId);
      const status = String(remote.status || '');
      const parsed = parseExternalRef(remote.external_reference);
      const empresaId = remote.metadata?.empresa_id || parsed.empresaId;
      const planoKey = remote.metadata?.plano || parsed.planoKey;
      if ((status === 'authorized' || status === 'active') && empresaId) {
        await activateFromMp(String(empresaId), planoKey, null, preId);
        await logWebhookEvent(getDb(), {
          source: 'mercadopago',
          event_type: type || 'preapproval_retry',
          status: 'ok',
          detail: `retry activate ${empresaId}`,
        });
        return;
      }
      if ((status === 'cancelled' || status === 'paused') && empresaId) {
        await blockEmpresa(getDb(), String(empresaId), { notify: true, tipo: 'cancelamento' });
        return;
      }
      throw new Error(`mp_webhook preapproval status=${status}`);
    }

    const paymentId = dataId || String(query.id || '');
    if (!paymentId) throw new Error('mp_webhook: payment id ausente');
    const remote = await getPayment(paymentId);
    const status = String(remote.status || '');
    const parsed = parseExternalRef(remote.external_reference);
    const empresaId = remote.metadata?.empresa_id || parsed.empresaId;
    const planoKey = remote.metadata?.plano || parsed.planoKey;

    if (status === 'approved' && empresaId) {
      await activateFromMp(String(empresaId), planoKey, paymentId, null);
      await logWebhookEvent(getDb(), {
        source: 'mercadopago',
        event_type: type || 'payment_retry',
        status: 'ok',
        detail: `retry activate ${empresaId}`,
      });
      return;
    }
    if ((status === 'refunded' || status === 'charged_back') && empresaId) {
      await blockEmpresa(getDb(), String(empresaId), { notify: true, tipo: 'assinatura' });
      return;
    }
    if (status === 'pending' || status === 'in_process') {
      throw new Error(`mp ainda pending (${status})`);
    }
  });

  registerRetryHandler('acquisition_email', async (payload) => {
    const sendId = String(payload.send_id || '').trim();
    if (!sendId) throw new Error('acquisition_email: send_id obrigatório');
    await processAcquisitionEmail(sendId, enviarEmail);
  });

  registerRetryHandler('n8n_webhook', async (payload) => {
    const event = String(payload.event || '').trim();
    if (!event) throw new Error('n8n_webhook: event obrigatório');
    const ok = await sendN8nWebhook(event, payload);
    if (!ok) throw new Error('n8n_webhook: webhook não aceitou o evento');
  });

  registerRetryHandler('email', async (payload) => {
    const to = String(payload.to || '');
    const subject = String(payload.subject || '');
    const text = String(payload.text || payload.html || '');
    if (!to || !subject) throw new Error('email inválido');
    const r = await enviarEmail({
      to,
      subject,
      text,
      html: payload.html ? String(payload.html) : undefined,
    });
    if (!r.ok) throw new Error('enviarEmail retornou ok=false');
  });

  async function sendTelegramBotMessage(chatId: string, message: string) {
    const token = String(process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || '').trim();
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN não configurado');
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });
    const raw = await response.text().catch(() => '');
    let data: any = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch {}
    if (!response.ok || data.ok === false) {
      throw new Error(`Telegram API HTTP ${response.status}: ${String(data?.description || raw).slice(0, 300)}`);
    }
    return { ok: true, mode: 'telegram', messageId: data?.result?.message_id ? String(data.result.message_id) : undefined };
  }

  async function sendChannel(channel: string, row: any, message: string, idempotencyKey: string) {
    if (channel === 'email') {
      const email = String(row.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) throw new Error('lead sem e-mail válido');
      return enviarEmail({
        to: email,
        subject: 'Filtra.AI — acompanhamento inicial',
        text: message,
        idempotencyKey,
      });
    }

    if (channel === 'telegram') {
      const chatId = String(row.telegram_chat_id || '').trim();
      if (!chatId) throw new Error('lead sem Telegram conectado; use /start <lead_id> no bot');
      return sendTelegramBotMessage(chatId, message);
    }

    const phone = String(row.telefone || '').trim();
    if (!phone) throw new Error(`lead sem telefone para ${channel}`);

    const urlEnv = channel === 'whatsapp' ? 'WHATSAPP_SEND_URL' : 'WECHAT_SEND_URL';
    const url = String(process.env[urlEnv] || '').trim();
    if (!url) throw new Error(`${urlEnv} não configurado`);

    const secret = String(process.env[`${urlEnv}_SECRET`] || process.env.CHANNEL_SEND_SECRET || '').trim();
    const headers: Record<string,string> = { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey };
    if (secret) headers.Authorization = `Bearer ${secret}`;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        channel,
        to: phone,
        message,
        idempotency_key: idempotencyKey,
        followup_id: String(row.id),
        lead_id: String(row.lead_id),
        nome_empresa: String(row.nome_empresa || ''),
      }),
    });
    const body = await response.text().catch(() => '');
    if (!response.ok) throw new Error(`${channel} HTTP ${response.status}: ${body.slice(0, 240)}`);
    let parsed: any = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch {}
    return { ok: true, mode: channel, messageId: parsed.message_id || parsed.id || undefined };
  }

  registerRetryHandler('followup_send', async (payload) => {
    const db = getDb();
    const followupId = String(payload.followup_id || '');
    if (!followupId) throw new Error('followup_id obrigatório');

    const row = await db.get(`
      SELECT f.*, l.email, l.telefone, l.telegram_chat_id, l.nome_empresa
      FROM lead_followups f
      LEFT JOIN leads l ON l.id = f.lead_id
      WHERE f.id = ?
    `, [followupId]);

    if (!row) throw new Error('follow-up não encontrado');
    if (row.status === 'sent') return;
    if (!['approved', 'failed'].includes(String(row.status))) {
      if (row.status === 'sending') return;
      throw new Error(`follow-up não autorizado: ${row.status}`);
    }

    const channel = String(row.channel || payload.channel || 'email').trim().toLowerCase();
    if (!['email', 'whatsapp', 'telegram', 'wechat'].includes(channel)) {
      throw new Error(`canal não suportado: ${channel}`);
    }

    const sendKey = `send:${followupId}`;
    const reserved = await db.run(
      `UPDATE lead_followups
       SET status = 'sending',
           send_idempotency_key = ?,
           retry_count = COALESCE(retry_count, 0) + 1,
           updated_at = CURRENT_TIMESTAMP,
           last_error = NULL
       WHERE id = ? AND status IN ('approved','failed')`,
      [sendKey, followupId]
    );
    if (!reserved?.changes) {
      const current = await db.get('SELECT status FROM lead_followups WHERE id = ?', [followupId]);
      if (current?.status === 'sent' || current?.status === 'sending') return;
      throw new Error('follow-up não pôde reservar o envio');
    }

    try {
      const result = await sendChannel(channel, row, String(row.draft || ''), sendKey);
      if (!result?.ok) throw new Error(result?.error || 'falha no envio');
      await db.run(
        `UPDATE lead_followups
         SET status = 'sent',
             sent_at = CURRENT_TIMESTAMP,
             message_id = ?,
             failed_at = NULL,
             last_error = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'sending'`,
        [result.messageId || null, followupId]
      );
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, 500);
      await db.run(
        `UPDATE lead_followups
         SET status = 'failed', failed_at = CURRENT_TIMESTAMP, last_error = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'sending'`,
        [err, followupId]
      );
      throw e;
    }
  });

  registerRetryHandler('generic', async (payload) => {
    if (payload?.throw) throw new Error(String(payload.throw));
  });
}
