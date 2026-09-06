/**
 * Checkout + Webhook PayPal (ativação automática + retry).
 */
import type { Express, Request, Response } from 'express';
import type { Database } from 'sqlite';
import { getDb } from '../lib/db.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  paypalConfigured,
  paypalWebhookConfigured,
  createPayPalOrder,
  capturePayPalOrder,
  verifyPayPalWebhook,
  parseCustomId,
  parsePlanoFromInvoiceId,
  getPayPalOrderSummary,
} from '../lib/paypal.js';
import { resolvePlano } from '../stripeBilling.js';
import { activatePlan, blockEmpresa } from '../services/billingService.js';
import { enqueueRetry } from '../lib/retryQueue.js';

async function ensurePaypalTables(db: Database) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS paypal_webhook_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT,
      processed_at TEXT NOT NULL,
      action TEXT,
      payload_summary TEXT
    );
  `);
  const cols = (await db.all(`PRAGMA table_info(empresas)`)).map((c: any) => c.name);
  if (!cols.includes('payment_gateway')) {
    await db.exec(`ALTER TABLE empresas ADD COLUMN payment_gateway TEXT`);
  }
}

async function alreadyProcessed(db: Database, eventId: string): Promise<boolean> {
  const row = await db.get(`SELECT event_id FROM paypal_webhook_events WHERE event_id = ?`, [
    eventId,
  ]);
  return Boolean(row);
}

async function markProcessed(
  db: Database,
  eventId: string,
  eventType: string,
  action: string,
  summary?: string
) {
  await db.run(
    `INSERT OR IGNORE INTO paypal_webhook_events (event_id, event_type, processed_at, action, payload_summary)
    VALUES (?, ?, datetime('now'), ?, ?)`,
    [eventId, eventType, action, (summary || '').slice(0, 500)]
  );
}

async function activateFromPayment(
  db: Database,
  opts: {
    empresaId: string;
    planoKey: string | null;
    captureId?: string | null;
    orderId?: string | null;
  }
) {
  const plano = resolvePlano(opts.planoKey || 'pro');
  const days = plano?.interval === 'year' ? 365 : 30;
  const exp = new Date();
  exp.setDate(exp.getDate() + days);

  await activatePlan(
    db,
    opts.empresaId,
    plano?.planDb || 'pro',
    null,
    `paypal:${opts.captureId || opts.orderId || 'unknown'}`,
    exp.toISOString()
  );

  await db.run(`UPDATE empresas SET payment_gateway = 'paypal', billing_cycle = ? WHERE id = ?`, [
    plano?.interval === 'year' ? 'year' : 'month',
    opts.empresaId,
  ]);

  return { plan: plano?.planDb, expira_em: exp.toISOString() };
}

export function mountPayPalRoutes(app: Express) {
  app.get('/api/paypal/status', (_req, res) => {
    res.json({
      configured: paypalConfigured(),
      webhook: paypalWebhookConfigured(),
      mode: process.env.PAYPAL_MODE || 'sandbox',
    });
  });

  app.post(
    '/api/paypal/create-order',
    asyncHandler(async (req: Request, res: Response) => {
      if (!paypalConfigured()) {
        return res.status(503).json({
          error: 'PayPal não configurado. Defina PAYPAL_CLIENT_ID e PAYPAL_CLIENT_SECRET.',
        });
      }
      const plano = String(req.body?.plano || '').trim();
      if (!resolvePlano(plano)) {
        return res.status(400).json({ error: 'Plano inválido.' });
      }
      const empresaId = req.body?.empresa_id ? String(req.body.empresa_id) : null;
      if (empresaId) {
        const emp = await getDb().get(`SELECT id FROM empresas WHERE id = ?`, [empresaId]);
        if (!emp) return res.status(404).json({ error: 'Empresa não encontrada.' });
      }

      const order = await createPayPalOrder({
        planoKey: plano,
        empresaId,
        email: req.body?.email ? String(req.body.email) : null,
      });

      res.json({
        success: true,
        order_id: order.orderId,
        approve_url: order.approveUrl,
        plano: order.label,
        value_monthly_ref: order.value,
        gateway: 'paypal',
      });
    })
  );

  app.post(
    '/api/paypal/capture-order',
    asyncHandler(async (req: Request, res: Response) => {
      if (!paypalConfigured()) {
        return res.status(503).json({ error: 'PayPal não configurado.' });
      }
      const orderId = String(req.body?.order_id || req.body?.orderID || '').trim();
      let planoKey = String(req.body?.plano || '').trim();
      let empresaId = req.body?.empresa_id ? String(req.body.empresa_id) : null;
      if (!orderId) return res.status(400).json({ error: 'order_id obrigatório.' });

      const db = getDb();
      await ensurePaypalTables(db);

      try {
        const cap = await capturePayPalOrder(orderId);
        const st = String(cap.status).toUpperCase();
        if (st !== 'COMPLETED' && st !== 'APPROVED') {
          await enqueueRetry({
            jobType: 'capture_paypal',
            dedupeKey: `capture:${orderId}`,
            payload: { order_id: orderId, empresa_id: empresaId, plano: planoKey },
            delayMs: 15_000,
          });
          return res.status(402).json({
            error: `Pagamento não concluído (${cap.status}). Reagendado para retry.`,
            capture: cap,
            retry: true,
          });
        }

        const parsed = parseCustomId(cap.customId);
        if (!empresaId) empresaId = parsed.empresaId;
        if (!planoKey) planoKey = parsed.planoKey || parsePlanoFromInvoiceId(cap.invoiceId) || '';

        if (!empresaId) {
          return res.json({
            success: true,
            payment: cap,
            aviso: 'Pagamento capturado; empresa_id ausente — ative no admin ou aguarde webhook.',
          });
        }

        const result = await activateFromPayment(db, {
          empresaId,
          planoKey: planoKey || 'pro',
          captureId: cap.captureId,
          orderId,
        });

        res.json({
          success: true,
          gateway: 'paypal',
          payment: cap,
          ...result,
        });
      } catch (e: any) {
        await enqueueRetry({
          jobType: 'capture_paypal',
          dedupeKey: `capture:${orderId}`,
          payload: { order_id: orderId, empresa_id: empresaId, plano: planoKey },
          delayMs: 20_000,
        });
        res.status(502).json({
          error: e?.message || 'Falha no capture — retry enfileirado',
          retry: true,
        });
      }
    })
  );

  app.post(
    '/api/webhook/paypal',
    asyncHandler(async (req: Request, res: Response) => {
      const event = req.body;
      if (!event || typeof event !== 'object') {
        return res.status(400).json({ error: 'Body inválido' });
      }

      try {
        const ok = await verifyPayPalWebhook({
          headers: req.headers as any,
          webhookEvent: event,
        });
        if (!ok) {
          console.error('[paypal webhook] assinatura inválida');
          return res.status(400).json({ error: 'Assinatura inválida' });
        }
      } catch (e: any) {
        console.error('[paypal webhook] verify:', e?.message || e);
        return res.status(400).json({ error: e?.message || 'Falha na verificação' });
      }

      const eventId = String(event.id || '');
      const eventType = String(event.event_type || '');
      const db = getDb();
      await ensurePaypalTables(db);

      if (eventId && (await alreadyProcessed(db, eventId))) {
        return res.json({ ok: true, action: 'duplicate' });
      }

      const resource = event.resource || {};

      try {
        if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
          let customId =
            resource.custom_id ||
            resource.custom ||
            resource.supplementary_data?.related_ids?.custom_id ||
            null;
          let orderId = resource.supplementary_data?.related_ids?.order_id || null;
          let invoiceId = resource.invoice_id || null;
          const captureId = resource.id || null;

          if (orderId && (!customId || !invoiceId)) {
            try {
              const order = await getPayPalOrderSummary(String(orderId));
              customId = customId || order.customId;
              invoiceId = invoiceId || order.invoiceId;
            } catch (e: any) {
              console.warn('[paypal webhook] get order:', e?.message);
              await enqueueRetry({
                jobType: 'paypal_webhook',
                dedupeKey: eventId ? `pp:${eventId}` : undefined,
                payload: { event_type: eventType, resource, event_id: eventId },
                delayMs: 30_000,
              });
              return res.json({ ok: true, action: 'retry_enqueued' });
            }
          }

          const parsed = parseCustomId(customId);
          const planoKey =
            parsed.planoKey || parsePlanoFromInvoiceId(invoiceId) || null;
          const empresaId = parsed.empresaId;

          if (!empresaId) {
            await markProcessed(
              db,
              eventId,
              eventType,
              'no_empresa',
              JSON.stringify({ captureId, orderId, customId })
            );
            return res.json({ ok: true, action: 'no_empresa' });
          }

          const result = await activateFromPayment(db, {
            empresaId,
            planoKey,
            captureId,
            orderId: orderId ? String(orderId) : null,
          });

          await markProcessed(db, eventId, eventType, 'activate', `${empresaId} ${result.plan}`);
          console.log(`[paypal webhook] ativado empresa=${empresaId} plan=${result.plan}`);
          return res.json({ ok: true, action: 'activate', ...result });
        }

        if (
          eventType === 'CHECKOUT.ORDER.APPROVED' ||
          eventType === 'CHECKOUT.ORDER.COMPLETED'
        ) {
          const orderId = resource.id;
          if (orderId) {
            try {
              const cap = await capturePayPalOrder(String(orderId));
              const parsed = parseCustomId(cap.customId);
              const planoKey =
                parsed.planoKey || parsePlanoFromInvoiceId(cap.invoiceId) || null;
              if (parsed.empresaId) {
                const result = await activateFromPayment(db, {
                  empresaId: parsed.empresaId,
                  planoKey,
                  captureId: cap.captureId,
                  orderId: String(orderId),
                });
                await markProcessed(
                  db,
                  eventId,
                  eventType,
                  'capture_and_activate',
                  `${parsed.empresaId}`
                );
                return res.json({ ok: true, action: 'capture_and_activate', ...result });
              }
            } catch (e: any) {
              console.warn('[paypal webhook] auto-capture:', e?.message || e);
              await enqueueRetry({
                jobType: 'paypal_webhook',
                dedupeKey: eventId ? `pp:${eventId}` : `pp-order:${orderId}`,
                payload: { event_type: eventType, resource, event_id: eventId },
                delayMs: 20_000,
              });
              await markProcessed(db, eventId, eventType, 'capture_failed_retry', e?.message);
              return res.json({ ok: true, action: 'retry_enqueued' });
            }
          }
          await markProcessed(db, eventId, eventType, 'ignore');
          return res.json({ ok: true, action: 'ignore' });
        }

        if (
          eventType === 'PAYMENT.CAPTURE.REFUNDED' ||
          eventType === 'PAYMENT.CAPTURE.REVERSED'
        ) {
          const customId = resource.custom_id || null;
          const parsed = parseCustomId(customId);
          let empresaId = parsed.empresaId;

          if (!empresaId && resource.id) {
            const row = await db.get(
              `SELECT id FROM empresas WHERE stripe_subscription_id = ?`,
              [`paypal:${resource.id}`]
            );
            if (row) empresaId = row.id;
          }

          if (empresaId) {
            await blockEmpresa(db, empresaId, { notify: true, tipo: 'assinatura' });
            await markProcessed(db, eventId, eventType, 'block_refund', empresaId);
            return res.json({ ok: true, action: 'block_refund' });
          }
          await markProcessed(db, eventId, eventType, 'refund_no_empresa');
          return res.json({ ok: true, action: 'refund_no_empresa' });
        }

        await markProcessed(db, eventId || `na-${Date.now()}`, eventType, 'ignore');
        return res.json({ ok: true, action: 'ignore', event_type: eventType });
      } catch (e: any) {
        console.error('[paypal webhook] process:', e?.message || e);
        try {
          await enqueueRetry({
            jobType: 'paypal_webhook',
            dedupeKey: eventId ? `pp:${eventId}` : undefined,
            payload: {
              event_type: eventType,
              resource,
              event_id: eventId,
            },
            delayMs: 30_000,
          });
        } catch (qe: any) {
          console.error('[paypal webhook] enqueue falhou:', qe?.message);
        }
        return res.status(200).json({ ok: false, error: e?.message || 'process error', retry: true });
      }
    })
  );
}
