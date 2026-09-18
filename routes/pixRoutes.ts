/**
 * Mercado Pago: Pix avulso/agendado/recorrente + webhook.
 */
import type { Express, Request, Response } from 'express';
import type { Database } from 'sqlite';
import { getDb } from '../lib/db.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  mpConfigured,
  mpPublicKey,
  mpTransparentReady,
  mpTokenMode,
  createTransparentPayment,
  createPixAvulso,
  createPixAgendado,
  createPixRecorrente,
  getPayment,
  getPreapproval,
  parseExternalRef,
  verifyMpWebhookSignature,
  planoAmountReais,
} from '../lib/mercadopago.js';
import { resolvePlano } from '../stripeBilling.js';
import { activatePlan, blockEmpresa } from '../services/billingService.js';
import { logWebhookEvent } from '../lib/opsLog.js';
import { claimPaymentCaptureOnce, completePaymentCapture, releasePaymentCapture } from '../lib/paymentEvents.js';

async function ensurePixTables(db: Database) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pix_payments (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      empresa_id TEXT,
      plano_key TEXT,
      amount DOUBLE PRECISION,
      status TEXT,
      qr_code TEXT,
      qr_code_base64 TEXT,
      ticket_url TEXT,
      external_reference TEXT,
      expires_at TEXT,
      preapproval_id TEXT,
      init_point TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);
  try {
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_pix_empresa ON pix_payments(empresa_id)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_pix_status ON pix_payments(status)`);
  } catch {
    /* ok */
  }
  try {
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
  } catch (e: any) {
    console.warn('[pix] ensure colunas empresas:', e?.message || e);
  }
}

/** INSERT que funciona em SQLite e Postgres (sem INSERT OR REPLACE). */
async function upsertPixPayment(
  db: Database,
  row: {
    id: string;
    kind: string;
    empresa_id: string | null;
    plano_key: string;
    amount: number;
    status: string;
    qr_code?: string | null;
    qr_code_base64?: string | null;
    ticket_url?: string | null;
    external_reference?: string | null;
    expires_at?: string | null;
    preapproval_id?: string | null;
    init_point?: string | null;
  }
) {
  const now = new Date().toISOString();
  try {
    await db.run(
      `INSERT INTO pix_payments
        (id, kind, empresa_id, plano_key, amount, status, qr_code, qr_code_base64, ticket_url,
         external_reference, expires_at, preapproval_id, init_point, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.kind,
        row.empresa_id,
        row.plano_key,
        row.amount,
        row.status,
        row.qr_code || null,
        row.qr_code_base64 || null,
        row.ticket_url || null,
        row.external_reference || null,
        row.expires_at || null,
        row.preapproval_id || null,
        row.init_point || null,
        now,
        now,
      ]
    );
  } catch {
    await db.run(
      `UPDATE pix_payments SET
         status = ?, qr_code = COALESCE(?, qr_code), qr_code_base64 = COALESCE(?, qr_code_base64),
         ticket_url = COALESCE(?, ticket_url), updated_at = ?
       WHERE id = ?`,
      [row.status, row.qr_code || null, row.qr_code_base64 || null, row.ticket_url || null, now, row.id]
    );
  }
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
  const paymentKey = opts.paymentId ? String(opts.paymentId).trim() : '';
  const claimed = paymentKey ? await claimPaymentCaptureOnce(db, 'mercadopago', paymentKey) : true;
  if (!claimed) return { plan: resolvePlano(opts.planoKey || 'pro')?.planDb, duplicate: true };

  const plano = resolvePlano(opts.planoKey || 'pro');
  const days = plano?.interval === 'year' ? 365 : 30;
  const exp = new Date();
  exp.setDate(exp.getDate() + days);

  try {
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
      `UPDATE empresas SET payment_gateway = 'mercadopago', billing_cycle = ? WHERE id = ?`,
    [plano?.interval === 'year' ? 'year' : 'month', opts.empresaId]
  );
    if (opts.preapprovalId) {
      await db.run(`UPDATE empresas SET mp_preapproval_id = ? WHERE id = ?`, [
        opts.preapprovalId,
        opts.empresaId,
      ]);
    }

    if (paymentKey) await completePaymentCapture(db, 'mercadopago', paymentKey);
    return { plan: plano?.planDb, expira_em: exp.toISOString(), duplicate: false };
  } catch (e) {
    if (paymentKey) await releasePaymentCapture(db, 'mercadopago', paymentKey);
    throw e;
  }
}

export function mountPixRoutes(app: Express) {
  app.get('/api/mp/config', (req, res) => {
    const planoKey = String(req.query.plano || '').trim();
    const plano = planoKey ? resolvePlano(planoKey) : null;
    res.json({
      configured: mpConfigured(),
      transparent_ready: mpTransparentReady(),
      public_key: mpPublicKey() || null,
      token_mode: mpTokenMode(),
      provider: 'mercadopago',
      amount: plano ? planoAmountReais(plano) : null,
      plano_label: plano?.label || null,
      currency: 'BRL',
      modes: ['transparente', 'avulso', 'agendado', 'recorrente'],
    });
  });

  app.get('/api/pix/status', (_req, res) => {
    res.json({
      configured: mpConfigured(),
      transparent_ready: mpTransparentReady(),
      public_key: Boolean(mpPublicKey()),
      token_mode: mpTokenMode(),
      provider: 'mercadopago',
      modes: ['avulso', 'agendado', 'recorrente'],
      endpoints: {
        avulso: 'POST /api/pix/avulso',
        agendado: 'POST /api/pix/agendado',
        recorrente: 'POST /api/pix/recorrente',
        poll: 'GET /api/pix/payment/:id',
        webhook: 'POST /api/webhook/mercadopago',
      },
      dica:
        mpTokenMode() === 'live'
          ? 'Token de PRODUÇÃO ativo.'
          : mpTokenMode() === 'test'
            ? 'Token de TESTE ativo.'
            : 'Defina MP_ACCESS_TOKEN (Access Token, não Public Key).',
    });
  });

  app.post(
    '/api/mp/process-payment',
    asyncHandler(async (req: Request, res: Response) => {
      if (!mpConfigured()) {
        return res.status(503).json({
          error: 'Mercado Pago não configurado. Defina MP_ACCESS_TOKEN no Render.',
        });
      }
      const plano = String(req.body?.plano || '').trim();
      if (!resolvePlano(plano)) return res.status(400).json({ error: 'Plano inválido.' });

      const formData = req.body?.formData || req.body?.form_data || req.body;
      if (!formData || typeof formData !== 'object') {
        return res.status(400).json({ error: 'formData do Brick é obrigatório.' });
      }

      const empresaId = req.body?.empresa_id ? String(req.body.empresa_id) : null;
      if (empresaId) {
        const emp = await getDb().get(`SELECT id FROM empresas WHERE id = ?`, [empresaId]);
        if (!emp) return res.status(404).json({ error: 'Empresa não encontrada.' });
      }

      try {
        const created = await createTransparentPayment({
          planoKey: plano,
          empresaId,
          formData,
        });

        const db = getDb();
        await ensurePixTables(db);
        await upsertPixPayment(db, {
          id: created.paymentId,
          kind: 'transparente',
          empresa_id: empresaId,
          plano_key: plano,
          amount: created.amount,
          status: created.status,
          qr_code: created.qrCode,
          qr_code_base64: created.qrCodeBase64,
          ticket_url: created.ticketUrl,
          external_reference: created.externalReference,
        });

        if ((created.status === 'approved' || created.status === 'authorized') && empresaId) {
          await activateFromPix(db, {
            empresaId,
            planoKey: plano,
            paymentId: created.paymentId,
          });
        }

        res.json({
          success: true,
          kind: 'transparente',
          payment_id: created.paymentId,
          status: created.status,
          status_detail: created.statusDetail,
          amount: created.amount,
          plano: created.planoLabel,
          payment_method_id: created.paymentMethodId,
          qr_code: created.qrCode,
          qr_code_base64: created.qrCodeBase64,
          copia_e_cola: created.qrCode,
          ticket_url: created.ticketUrl,
          approved: created.status === 'approved',
          poll_url: `/api/pix/payment/${created.paymentId}`,
        });
      } catch (e: any) {
        console.error('[pix] process-payment', e?.message || e, e?.body);
        throw e;
      }
    })
  );

  app.post(
    '/api/pix/avulso',
    asyncHandler(async (req: Request, res: Response) => {
      if (!mpConfigured()) {
        return res.status(503).json({
          error: 'Pix não configurado. Defina MP_ACCESS_TOKEN no Render (Access Token).',
        });
      }
      const plano = String(req.body?.plano || '').trim();
      if (!resolvePlano(plano)) return res.status(400).json({ error: 'Plano inválido.' });

      const empresaId = req.body?.empresa_id ? String(req.body.empresa_id) : null;
      if (empresaId) {
        const emp = await getDb().get(`SELECT id FROM empresas WHERE id = ?`, [empresaId]);
        if (!emp) return res.status(404).json({ error: 'Empresa não encontrada.' });
      }

      try {
        const created = await createPixAvulso({
          planoKey: plano,
          empresaId,
          email: req.body?.email ? String(req.body.email) : null,
          nomePagador: req.body?.nome ? String(req.body.nome) : null,
          cpf: req.body?.cpf ? String(req.body.cpf) : null,
        });

        const db = getDb();
        await ensurePixTables(db);
        await upsertPixPayment(db, {
          id: created.paymentId,
          kind: 'avulso',
          empresa_id: empresaId,
          plano_key: plano,
          amount: created.amount,
          status: created.status,
          qr_code: created.qrCode,
          qr_code_base64: created.qrCodeBase64,
          ticket_url: created.ticketUrl,
          external_reference: created.externalReference,
          expires_at: created.expiresAt,
        });

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
      } catch (e: any) {
        console.error('[pix] avulso falhou:', e?.message || e);
        if (e?.body) console.error('[pix] MP body:', JSON.stringify(e.body).slice(0, 800));
        throw e;
      }
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
      try {
        const created = await createPixAgendado({
          planoKey: plano,
          empresaId,
          email: req.body?.email ? String(req.body.email) : null,
          nomePagador: req.body?.nome ? String(req.body.nome) : null,
          venceEmIso: venceEm,
        });

        const db = getDb();
        await ensurePixTables(db);
        await upsertPixPayment(db, {
          id: created.paymentId,
          kind: 'agendado',
          empresa_id: empresaId,
          plano_key: plano,
          amount: created.amount,
          status: created.status,
          qr_code: created.qrCode,
          qr_code_base64: created.qrCodeBase64,
          ticket_url: created.ticketUrl,
          external_reference: created.externalReference,
          expires_at: created.expiresAt,
        });

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
      } catch (e: any) {
        console.error('[pix] agendado falhou:', e?.message || e);
        throw e;
      }
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
      try {
        const created = await createPixRecorrente({
          planoKey: plano,
          empresaId,
          email,
        });

        const db = getDb();
        await ensurePixTables(db);
        await upsertPixPayment(db, {
          id: created.preapprovalId,
          kind: 'recorrente',
          empresa_id: empresaId,
          plano_key: plano,
          amount: created.amount,
          status: created.status,
          external_reference: created.externalReference,
          preapproval_id: created.preapprovalId,
          init_point: created.initPoint,
        });

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
      } catch (e: any) {
        console.error('[pix] recorrente falhou:', e?.message || e);
        throw e;
      }
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

      await db.run(`UPDATE pix_payments SET status = ?, updated_at = ? WHERE id = ?`, [
        status,
        new Date().toISOString(),
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
        // Não expor identificadores internos da empresa em endpoint público de polling.
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
      // Mercado Pago signs the data.id from the query string, not the JSON body.
      const queryDataId = String((req.query as any)['data.id'] || '').trim();
      const type = String(req.query.type || body.type || body.action || body.topic || '').trim();
      const dataId = String(queryDataId || body.data?.id || body.id || (body as any)['data.id'] || '').trim();

      const xSig = (req.headers['x-signature'] as string) || '';
      const xReq = (req.headers['x-request-id'] as string) || '';

      if (process.env.MP_WEBHOOK_SECRET?.trim() && xSig) {
        const okSig = verifyMpWebhookSignature({
          xSignature: xSig,
          xRequestId: xReq,
          dataId: queryDataId || dataId || null,
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

      const topic = String(req.query.topic || req.query.type || body.topic || type || '').trim();
      const qid = String(req.query.id || queryDataId || dataId || '').trim();

      try {
        if (
          topic.includes('payment') ||
          type.includes('payment') ||
          type === 'payment.updated' ||
          type === 'payment.created'
        ) {
          const paymentId = qid || dataId;
          if (!paymentId) return res.json({ ok: true, action: 'no_id' });

          const remote = await getPayment(paymentId);
          const status = String(remote.status || '');
          const parsed = parseExternalRef(remote.external_reference);
          const empresaId = remote.metadata?.empresa_id || parsed.empresaId || null;
          const planoKey = remote.metadata?.plano || parsed.planoKey || null;

          await db.run(`UPDATE pix_payments SET status = ?, updated_at = ? WHERE id = ?`, [
            status,
            new Date().toISOString(),
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

          if (['refunded', 'charged_back'].includes(status) && empresaId) {
            await blockEmpresa(db, String(empresaId), { notify: true, tipo: 'assinatura' });
            await logWebhookEvent(db, {
              source: 'mercadopago',
              event_type: type || topic,
              status: 'ok',
              detail: `block ${status} ${empresaId}`,
            });
            return res.json({ ok: true, action: 'block' });
          }

          await logWebhookEvent(db, {
            source: 'mercadopago',
            event_type: type || topic,
            status: 'ok',
            detail: `status=${status}`,
          });
          return res.json({ ok: true, action: 'status', status });
        }

        await logWebhookEvent(db, {
          source: 'mercadopago',
          event_type: type || topic || 'unknown',
          status: 'ok',
          detail: 'ignored',
        });
        return res.json({ ok: true, action: 'ignored' });
      } catch (e: any) {
        console.error('[mp webhook]', e?.message || e);
        await logWebhookEvent(db, {
          source: 'mercadopago',
          event_type: type || 'error',
          status: 'error',
          detail: String(e?.message || e).slice(0, 400),
        });
        return res.status(500).json({ error: 'webhook_error' });
      }
    })
  );
}
