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
import { resolvePlano } from '../stripeBilling.js';
import { activatePlan, blockEmpresa } from '../services/billingService.js';
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
    await db.run(`UPDATE empresas SET payment_gateway = 'paypal', billing_cycle = ? WHERE id = ?`, [
      plano?.interval === 'year' ? 'year' : 'month',
      empresaId,
    ]);
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

  registerRetryHandler('generic', async (payload) => {
    if (payload?.throw) throw new Error(String(payload.throw));
  });
}
