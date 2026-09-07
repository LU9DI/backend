/**
 * Rotas Pix (Mercado Pago): avulso, agendado, recorrente + webhook.
 */
import type { Express, Request, Response } from 'express';
import type { Database } from 'sqlite';
import { getDb } from '../lib/db.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  mpConfigured,
  mpTokenMode,
  createPixAvulso,
  createPixAgendado,
  createPixRecorrente,
  getPayment,
  getPreapproval,
  parseExternalRef,
  verifyMpWebhookSignature,
} from '../lib/mercadopago.js';
import { resolvePlano } from '../stripeBilling.js';
import { activatePlan, blockEmpresa } from '../services/billingService.js';
import { logWebhookEvent } from '../lib/opsLog.js';
import { enqueueRetry } from '../lib/retryQueue.js';

async function ensurePixTables(db: Database) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pix_payments (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      empresa_id TEXT,
      plano_key TEXT,
      amount REAL,
      status TEXT,
      qr_code TEXT,
      qr_code_base64 TEXT,
      ticket_url TEXT,
      external_reference TEXT,
      expires_at TEXT,
      preapproval_id TEXT,
      init_point TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pix_empresa ON pix_payments(empresa_id);
    CREATE INDEX IF NOT EXISTS idx_pix_status ON pix_payments(status);
  `);
  const cols = (await db.all(`PRAGMA table_info(empresas)`)).map((c: any) => c.name);
  if (!cols.includes('payment_gateway')) {
    await db.exec(`ALTER TABLE empresas ADD COLUMN payment_gateway TEXT`);
  }
  if (!cols.includes('mp_preapproval_id')) {
    await db.exec(`ALTER TABLE empresas ADD COLUMN mp_preapproval_id TEXT`);
  }
  if (!cols.includes('billing_cycle')) {
    await db.exec(`ALTER TABLE empresas ADD COLUMN billing_cycle TEXT`);
  }
}

function mpHttpError(res: Response, e: any) {
  const status = Number(e?.status) >= 400 && Number(e?.status) < 600 ? Number(e.status) : 502;
  return res.status(status).json({
    error: e?.message || 'Erro Mercado Pago',
    provider: 'mercadopago',
    token_mode: mpTokenMode(),
  });
}

async function activateFromPix(
  db: Database,
  opts: {
    empresaId: string;
    planoKey: string | null;
    paymentId?: string | null;
    preapprovalId?: string | null;
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
    opts.preapprovalId
      ? `mp_preapproval:${opts.preapprovalId}`
      : opts.paymentId
        ? `mp_pix:${opts.paymentId}`
        : `mp_pix:unknown`,
    exp.toISOString()
  );

  await db.run(
    `UPDATE empresas SET payment_gateway = 'mercadopago_pix', billing_cycle = ? WHERE id = ?`,
    [plano?.interval === 'year' ? 'year' : 'month', opts.empresaId]
  );
  if (opts.preapprovalId) {
    await db.run(`UPDATE empresas SET mp_preapproval_id = ? WHERE id = ?`, [
      opts.preapprovalId,
      opts.empresaId,
    ]);
  }

  return { plan: plano?.planDb, expira_em: exp.toISOString() };
}

export function mountPixRoutes(app: Express) {
  app.get('/api/pix/status', (_req, res) => {
    res.json({
      configured: mpConfigured(),
      provider: 'mercadopago',
      token_mode: mpTokenMode(),
      modes: ['avulso', 'agendado', 'recorrente'],
      endpoints: {
        avulso: 'POST /api/pix/avulso',
        agendado: 'POST /api/pix/agendado',
        recorrente: 'POST /api/pix/recorrente',
        poll: 'GET /api/pix/payment/:id',
        webhook: 'POST /api/webhook/mercadopago',
      },
      dica:
        mpTokenMode() === 'unknown'
          ? 'MP_ACCESS_TOKEN deve começar com APP_USR- (produção) ou TEST- (sandbox). Não use Public Key.'
          : mpTokenMode() === 'test'
            ? 'Token de TESTE ativo — pagamentos são simulados.'
            : 'Token de PRODUÇÃO ativo.',
    });
  });

  app.post(
    '/api/pix/avulso',
    asyncHandler(async (req: Request, res: Response) => {
      if (!mpConfigured()) {
        return res.status(503).json({
          error:
            'Pix não configurado. Defina MP_ACCESS_TOKEN no Render (Access Token do Mercado Pago).',
        });
      }
      const plano = String(req.body?.plano || '').trim();
      if (!resolvePlano(plano)) return res.status(400).json({ error: 'Plano inválido.' });

      const empresaId = req.body?.empresa_id ? String(req.body.empresa_id) : null;
      if (empresaId) {
        const emp = await getDb().get(`SELECT id FROM empresas WHERE id = ?`, [empresaId]);
        if (!emp) return res.status(404).json({ error: 'Empresa não encontrada.' });
      }

      let created;
      try {
        created = await createPixAvulso({
          planoKey: plano,
          empresaId,
          email: req.body?.email ? String(req.body.email) : null,
          nomePagador: req.body?.nome ? String(req.body.nome) : null,
          cpf: req.body?.cpf ? String(req.body.cpf) : null,
        });
      } catch (e: any) {
        return mpHttpError(res, e);
      }

      const db = getDb();
      await ensurePixTables(db);
      const now = new Date().toISOString();
      await db.run(
        `INSERT OR REPLACE INTO pix_payments
          (id, kind, empresa_id, plano_key, amount, status, qr_code, qr_code_base64, ticket_url,
           external_reference, expires_at, created_at, updated_at)
         VALUES (?, 'avulso', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          created.paymentId,
          empresaId,
          plano,
          created.amount,
          created.status,
          created.qrCode,
          created.qrCodeBase64,
          created.ticketUrl,
          created.externalReference,
          created.expiresAt,
          now,
          now,
        ]
      );

      res.json({
        success: true,
        kind: 'avulso',
        payment_id: created.paymentId,
        status: created.status,
        amount: created.amount,
        plano: created.planoLabel,
        qr_code: created.qrCode,
        qr_code_base64: created.qrCodeBase64,
        copia_e_cola: created.qrCode,
        ticket_url: created.ticketUrl,
        expires_at: created.expiresAt,
        poll_url: `/api/pix/payment/${created.paymentId}`,
      });
    })
  );

  app.post(
    '/api/pix/agendado',
    asyncHandler(async (req: Request, res: Response) => {
      if (!mpConfigured()) {
        return res.status(503).json({ error: 'Pix não configurado (MP_ACCESS_TOKEN).' });
      }
      const plano = String(req.body?.plano || '').trim();
      if (!resolvePlano(plano)) return res.status(400).json({ error: 'Plano inválido.' });
      const venceEm = String(req.body?.vence_em || req.body?.date || '').trim();
      if (!venceEm) {
        return res.status(400).json({
          error: 'Informe vence_em (ISO 8601), ex: 2026-09-20T23:59:00.000-03:00',
        });
      }

      const empresaId = req.body?.empresa_id ? String(req.body.empresa_id) : null;
      let created;
      try {
        created = await createPixAgendado({
          planoKey: plano,
          empresaId,
          email: req.body?.email ? String(req.body.email) : null,
          nomePagador: req.body?.nome ? String(req.body.nome) : null,
          venceEmIso: venceEm,
        });
      } catch (e: any) {
        return mpHttpError(res, e);
      }

      const db = getDb();
      await ensurePixTables(db);
      const now = new Date().toISOString();
      await db.run(
        `INSERT OR REPLACE INTO pix_payments
          (id, kind, empresa_id, plano_key, amount, status, qr_code, qr_code_base64, ticket_url,
           external_reference, expires_at, created_at, updated_at)
         VALUES (?, 'agendado', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          created.paymentId,
          empresaId,
          plano,
          created.amount,
          created.status,
          created.qrCode,
          created.qrCodeBase64,
          created.ticketUrl,
          created.externalReference,
          created.expiresAt,
          now,
          now,
        ]
      );

      res.json({
        success: true,
        kind: 'agendado',
        payment_id: created.paymentId,
        status: created.status,
        amount: created.amount,
        plano: created.planoLabel,
        qr_code: created.qrCode,
        qr_code_base64: created.qrCodeBase64,
        copia_e_cola: created.qrCode,
        ticket_url: created.ticketUrl,
        expires_at: created.expiresAt,
        poll_url: `/api/pix/payment/${created.paymentId}`,
      });
    })
  );

  app.post(
    '/api/pix/recorrente',
    asyncHandler(async (req: Request, res: Response) => {
      if (!mpConfigured()) {
        return res.status(503).json({ error: 'Pix não configurado (MP_ACCESS_TOKEN).' });
      }
      const plano = String(req.body?.plano || '').trim();
      if (!resolvePlano(plano)) return res.status(400).json({ error: 'Plano inválido.' });
      const email = req.body?.email ? String(req.body.email).trim() : '';
      if (!email || !email.includes('@')) {
        return res.status(400).json({
          error: 'E-mail do pagador é obrigatório para assinatura recorrente.',
        });
      }

      const empresaId = req.body?.empresa_id ? String(req.body.empresa_id) : null;
      let created;
      try {
        created = await createPixRecorrente({
          planoKey: plano,
          empresaId,
          email,
        });
      } catch (e: any) {
        return mpHttpError(res, e);
      }

      const db = getDb();
      await ensurePixTables(db);
      const now = new Date().toISOString();
      await db.run(
        `INSERT OR REPLACE INTO pix_payments
          (id, kind, empresa_id, plano_key, amount, status, external_reference,
           preapproval_id, init_point, created_at, updated_at)
         VALUES (?, 'recorrente', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          created.preapprovalId,
          empresaId,
          plano,
          created.amount,
          created.status,
          created.externalReference,
          created.preapprovalId,
          created.initPoint,
          now,
          now,
        ]
      );

      res.json({
        success: true,
        kind: 'recorrente',
        preapproval_id: created.preapprovalId,
        init_point: created.initPoint,
        status: created.status,
        amount: created.amount,
        plano: created.planoLabel,
        frequency: created.frequency,
        frequency_type: created.frequencyType,
        authorize_url: created.initPoint,
      });
    })
  );

  app.get(
    '/api/pix/payment/:id',
    asyncHandler(async (req: Request, res: Response) => {
      if (!mpConfigured()) {
        return res.status(503).json({ error: 'Pix não configurado.' });
      }
      const id = String(req.params.id);
      const db = getDb();
      await ensurePixTables(db);

      let remote: any;
      try {
        remote = await getPayment(id);
      } catch {
        try {
          remote = await getPreapproval(id);
          return res.json({
            id,
            kind: 'recorrente',
            status: remote.status,
            preapproval: true,
            init_point: remote.init_point || remote.sandbox_init_point,
          });
        } catch (e: any) {
          return res.status(404).json({ error: e?.message || 'Pagamento não encontrado' });
        }
      }

      const status = String(remote.status || '');
      const parsed = parseExternalRef(remote.external_reference);
      const empresaId = remote.metadata?.empresa_id || parsed.empresaId || null;
      const planoKey = remote.metadata?.plano || parsed.planoKey || null;

      await db.run(`UPDATE pix_payments SET status = ?, updated_at = NOW() WHERE id = ?`, [
        status,
        id,
      ]);

      if ((status === 'approved' || status === 'authorized') && empresaId) {
        const emp = await db.get(`SELECT id, status, plan FROM empresas WHERE id = ?`, [empresaId]);
        if (emp && emp.status !== 'ativo') {
          await activateFromPix(db, {
            empresaId: String(empresaId),
            planoKey,
            paymentId: id,
          });
        }
      }

      const poi = remote.point_of_interaction?.transaction_data || {};
      res.json({
        id,
        status,
        status_detail: remote.status_detail,
        amount: remote.transaction_amount,
        empresa_id: empresaId,
        plano: planoKey,
        qr_code: poi.qr_code || null,
        copia_e_cola: poi.qr_code || null,
        approved: status === 'approved',
      });
    })
  );

  app.post(
    '/api/webhook/mercadopago',
    asyncHandler(async (req: Request, res: Response) => {
      const db = getDb();
      await ensurePixTables(db);

      const body = req.body || {};
      const type = String(body.type || body.action || body.topic || '');
      const dataId = String(
        body.data?.id || body.id || (body as any)['data.id'] || ''
      ).trim();

      const xSig = (req.headers['x-signature'] as string) || '';
      const xReq = (req.headers['x-request-id'] as string) || '';

      if (process.env.MP_WEBHOOK_SECRET?.trim() && xSig) {
        const okSig = verifyMpWebhookSignature({
          xSignature: xSig,
          xRequestId: xReq,
          dataId: dataId || null,
        });
        if (!okSig) {
          await logWebhookEvent(db, {
            source: 'mercadopago',
            event_type: type || 'unknown',
            status: 'error',
            detail: 'assinatura inválida',
          });
          return res.status(401).json({ error: 'Assinatura inválida' });
        }
      }

      const topic = String(req.query.topic || body.topic || type || '');
      const qid = String(req.query.id || dataId || '').trim();

      try {
        if (
          topic.includes('payment') ||
          type.includes('payment') ||
          type === 'payment.updated' ||
          type === 'payment.created'
        ) {
          const paymentId = qid || dataId;
          if (!paymentId) {
            return res.json({ ok: true, action: 'no_id' });
          }

          const remote = await getPayment(paymentId);
          const status = String(remote.status || '');
          const parsed = parseExternalRef(remote.external_reference);
          const empresaId = remote.metadata?.empresa_id || parsed.empresaId || null;
          const planoKey = remote.metadata?.plano || parsed.planoKey || null;

          await db.run(`UPDATE pix_payments SET status = ?, updated_at = NOW() WHERE id = ?`, [
            status,
            paymentId,
          ]);

          if (status === 'approved' && empresaId) {
            const result = await activateFromPix(db, {
              empresaId: String(empresaId),
              planoKey,
              paymentId,
            });
            await logWebhookEvent(db, {
              source: 'mercadopago',
              event_type: type || topic,
              status: 'ok',
              detail: `activate ${empresaId} ${result.plan}`,
            });
            return res.json({ ok: true, action: 'activate', ...result });
          }

          if (
            ['cancelled', 'rejected', 'refunded', 'charged_back'].includes(status) &&
            empresaId
          ) {
            if (status === 'refunded' || status === 'charged_back') {
              await blockEmpresa(db, String(empresaId), { notify: true, tipo: 'assinatura' });
              await logWebhookEvent(db, {
                source: 'mercadopago',
                event_type: type || topic,
                status: 'ok',
                detail: `block ${status} ${empresaId}`,
              });
              return res.json({ ok: true, action: 'block' });
            }
          }

          await logWebhookEvent(db, {
            source: 'mercadopago',
            event_type: type || topic,
            status: 'ok',
            detail: `status=${status}`,
          });
          return res.json({ ok: true, action: 'status', status });
        }

        if (
          topic.includes('subscription') ||
          type.includes('subscription_preapproval') ||
          type.includes('preapproval')
        ) {
          const preId = qid || dataId;
          if (!preId) return res.json({ ok: true, action: 'no_preapproval_id' });
          const remote = await getPreapproval(preId);
          const status = String(remote.status || '');
          const parsed = parseExternalRef(remote.external_reference);
          const empresaId = remote.metadata?.empresa_id || parsed.empresaId || null;
          const planoKey = remote.metadata?.plano || parsed.planoKey || null;

          if ((status === 'authorized' || status === 'active') && empresaId) {
            const result = await activateFromPix(db, {
              empresaId: String(empresaId),
              planoKey,
              preapprovalId: preId,
            });
            await logWebhookEvent(db, {
              source: 'mercadopago',
              event_type: type || topic,
              status: 'ok',
              detail: `preapproval activate ${empresaId}`,
            });
            return res.json({ ok: true, action: 'preapproval_activate', ...result });
          }

          if ((status === 'cancelled' || status === 'paused') && empresaId) {
            await blockEmpresa(db, String(empresaId), { notify: true, tipo: 'cancelamento' });
            return res.json({ ok: true, action: 'preapproval_cancel' });
          }

          return res.json({ ok: true, action: 'preapproval_status', status });
        }

        await logWebhookEvent(db, {
          source: 'mercadopago',
          event_type: type || topic || 'unknown',
          status: 'ignored',
          detail: JSON.stringify(body).slice(0, 300),
        });
        return res.json({ ok: true, action: 'ignore' });
      } catch (e: any) {
        console.error('[mp webhook]', e?.message || e);
        try {
          await enqueueRetry({
            jobType: 'mp_webhook',
            dedupeKey: dataId ? `mp:${dataId}` : undefined,
            payload: { body, query: req.query as Record<string, unknown> },
            delayMs: 20_000,
          });
        } catch {
          /* */
        }
        await logWebhookEvent(db, {
          source: 'mercadopago',
          event_type: type || 'error',
          status: 'error',
          detail: e?.message || 'webhook error',
        });
        return res.status(200).json({ ok: false, retry: true, error: e?.message });
      }
    })
  );
}
