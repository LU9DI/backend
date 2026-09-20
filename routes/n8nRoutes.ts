/**
 * Rotas n8n (Postgres-safe).
 *   GET  /api/n8n/status
 *   POST /api/n8n/ping
 *   POST /api/n8n/inbound/lead
 *   POST /api/n8n/inbound/review
 */
import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { getDb, findEmpresa } from '../lib/db.js';
import { qualifyLead } from '../services/leadAutomation.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  n8nConfigured,
  n8nStatus,
  queueN8nEvent,
  notifyN8nAsync,
  verifyInboundSecret,
} from '../lib/n8n.js';
import { ensureFollowupSchema } from './adminFollowupRoutes.js';

async function ensureN8nIdempotencySchema() {
  const db = getDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS n8n_idempotency_keys (
      idempotency_key TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL
    )
  `);
  try {
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_n8n_idempotency_created
      ON n8n_idempotency_keys(created_at)
    `);
  } catch {}
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: { error: 'Rate limit n8n.' },
});

function requireInbound(req: Request, res: Response): boolean {
  const secret =
    (req.headers['x-filtra-secret'] as string) ||
    (req.headers['x-n8n-secret'] as string) ||
    '';
  if (!verifyInboundSecret(secret)) {
    res.status(401).json({ error: 'Secret n8n inválido ou ausente.' });
    return false;
  }
  return true;
}

export function mountN8nRoutes(app: Express) {
  app.get('/api/n8n/status', (_req, res) => {
    res.json({
      ...n8nStatus(),
      endpoints: {
        status: 'GET /api/n8n/status',
        ping: 'POST /api/n8n/ping',
        inbound_lead: 'POST /api/n8n/inbound/lead',
        inbound_review: 'POST /api/n8n/inbound/review',
        automation_claim: 'POST /api/n8n/inbound/automation-claim',
      },
      hint: n8nConfigured()
        ? 'Webhook de saída configurado.'
        : 'Defina N8N_WEBHOOK_URL no Render para ligar a saída.',
    });
  });

  app.post(
    '/api/n8n/ping',
    limiter,
    asyncHandler(async (_req: Request, res: Response) => {
      if (!n8nConfigured()) {
        return res.status(503).json({
          error: 'N8N_WEBHOOK_URL não configurado.',
          configured: false,
        });
      }
      const ok = await notifyN8nAsync('ping', { message: 'Filtra.IA connectivity check' });
      res.json({ success: ok, configured: true });
    })
  );

  app.post(
    '/api/n8n/inbound/lead',
    limiter,
    asyncHandler(async (req: Request, res: Response) => {
      if (!requireInbound(req, res)) return;

      const body = req.body || {};
      const nome = String(body.nome_empresa || body.name || body.nome || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const telefone = String(body.telefone || body.phone || body.whatsapp || '').trim();
      const fonte = String(body.fonte || body.source || 'n8n').trim();
      const mapsUrl = String(body.google_maps_url || body.maps_url || '').trim();

      if (!nome && !email && !telefone) {
        return res.status(400).json({
          error: 'Informe ao menos nome_empresa, email ou telefone.',
        });
      }

      const db = getDb();
      const now = new Date().toISOString();

      await db.exec(`
        CREATE TABLE IF NOT EXISTS leads (
          id TEXT PRIMARY KEY,
          nome_empresa TEXT,
          email TEXT,
          telefone TEXT,
          fonte TEXT,
          maps_url TEXT,
          raw_json TEXT,
          criado_em TIMESTAMPTZ NOT NULL
        )
      `);

      const id = crypto.randomUUID();
      await db.run(
        `INSERT INTO leads (id, nome_empresa, email, telefone, fonte, maps_url, raw_json, criado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          nome || null,
          email || null,
          telefone || null,
          fonte,
          mapsUrl || null,
          JSON.stringify(body).slice(0, 4000),
          now,
        ]
      );

      await queueN8nEvent('lead.captured', {
        lead_id: id,
        nome_empresa: nome,
        email,
        telefone,
        fonte,
      }, { dedupeKey: 'n8n:lead.captured:' + id });

      const qualification = await qualifyLead({
        nome_empresa: nome,
        email,
        telefone,
        fonte,
        maps_url: mapsUrl,
      });

      if (qualification) {
        try {
          await db.exec('ALTER TABLE leads ADD COLUMN score INTEGER');
        } catch {}
        try {
          await db.exec('ALTER TABLE leads ADD COLUMN qualification TEXT');
        } catch {}
        try {
          await db.exec('ALTER TABLE leads ADD COLUMN ai_reason TEXT');
        } catch {}
        await db.run(
          'UPDATE leads SET score = ?, qualification = ?, ai_reason = ? WHERE id = ?',
          [qualification.score, qualification.qualification, qualification.reason, id]
        );
        await queueN8nEvent('lead.qualified', {
          lead_id: id,
          nome_empresa: nome,
          email,
          telefone,
          fonte,
          score: qualification.score,
          qualification: qualification.qualification,
          reason: qualification.reason,
        }, { dedupeKey: 'n8n:lead.qualified:' + id });
        if (qualification.score >= 40) {
          await queueN8nEvent('lead.followup.requested', {
            lead_id: id,
            nome_empresa: nome,
            email,
            telefone,
            fonte,
            score: qualification.score,
            qualification: qualification.qualification,
            reason: qualification.reason,
            action: 'create_crm_followup',
          }, { dedupeKey: 'n8n:lead.followup.requested:' + id });
        }
      }

      res.status(201).json({ success: true, lead_id: id, qualification });
    })
  );

  app.post(
    '/api/n8n/inbound/automation-claim',
    limiter,
    asyncHandler(async (req: Request, res: Response) => {
      if (!requireInbound(req, res)) return;

      const idempotencyKey = String(
        req.headers['x-idempotency-key'] || req.body?.idempotency_key || ''
      ).trim();

      if (!idempotencyKey || idempotencyKey.length > 512) {
        return res.status(400).json({
          claimed: false,
          duplicate: false,
          error: 'X-Idempotency-Key obrigatório.',
        });
      }

      await ensureN8nIdempotencySchema();
      const db = getDb();
      const now = new Date().toISOString();

      // Atomic claim: exactly one concurrent request can insert the same key.
      const inserted = await db.run(
        `INSERT INTO n8n_idempotency_keys (idempotency_key, created_at)
         VALUES (?, ?)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [idempotencyKey, now]
      );

      // Keep the durable ledger bounded without affecting the current claim.
      try {
        await db.run(
          `DELETE FROM n8n_idempotency_keys
           WHERE created_at < ?`,
          [new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()]
        );
      } catch {}

      const claimed = Number(inserted?.changes ?? 0) === 1;
      return res.json({
        claimed,
        duplicate: !claimed,
        idempotency_key: idempotencyKey,
      });
    })
  );

  app.post(
    '/api/n8n/inbound/automation-result',
    limiter,
    asyncHandler(async (req: Request, res: Response) => {
      if (!requireInbound(req, res)) return;
      const body = req.body || {};
      const leadId = String(body.lead_id || '').trim();
      const action = String(body.action || '').trim();
      const status = String(body.status || '').trim().toLowerCase();
      const crmId = String(body.crm_id || '').trim();
      if (!leadId || !['hubspot_sync', 'followup'].includes(action) || !['success', 'failed', 'pending'].includes(status)) {
        return res.status(400).json({ error: 'lead_id, action e status inválidos.' });
      }

      const db = getDb();
      let resolvedLeadId = leadId;
      let lead = await db.get('SELECT id FROM leads WHERE id = ?', [leadId]);

      // Compatibility: older n8n callers may send an empresa id in lead_id.
      // Canonical behavior remains to use the real lead UUID whenever supplied.
      if (!lead) {
        const empresa = await db.get('SELECT id FROM empresas WHERE id = ?', [leadId]);
        if (empresa) {
          lead = await db.get(
            'SELECT id FROM leads WHERE raw_json LIKE ? ORDER BY criado_em DESC LIMIT 1',
            ['%"empresa_id":"' + String(empresa.id).replace(/"/g, '') + '"%']
          );
          if (lead) resolvedLeadId = String(lead.id);
        }
      }

      if (!lead) return res.status(404).json({ error: 'Lead não encontrado.', lead_id: leadId });

      try { await db.exec('ALTER TABLE leads ADD COLUMN crm_status TEXT DEFAULT \'pending\''); } catch {}
      try { await db.exec('ALTER TABLE leads ADD COLUMN crm_id TEXT'); } catch {}
      try { await db.exec('ALTER TABLE leads ADD COLUMN followup_status TEXT DEFAULT \'pending\''); } catch {}

      if (action === 'hubspot_sync') {
        await db.run(
          'UPDATE leads SET crm_status = ?, crm_id = COALESCE(NULLIF(?, \'\'), crm_id) WHERE id = ?',
          [status === 'success' ? 'synced' : status, crmId, resolvedLeadId]
        );
      } else {
        const followupStatus = status === 'success' ? 'created' : status;
        await db.run('UPDATE leads SET followup_status = ? WHERE id = ?', [followupStatus, resolvedLeadId]);

        // n8n gera o rascunho; o backend passa a ser a fonte de verdade
        // para aprovação e histórico. Nunca marca como aprovado aqui.
        if (status === 'pending' && String(body.draft || '').trim()) {
          await ensureFollowupSchema(db);
          const existing = await db.get(
            `SELECT id FROM lead_followups
             WHERE lead_id = ? AND status IN ('pending','approved','sending')`,
            [resolvedLeadId]
          );
          if (!existing) {
            await db.run(
              `INSERT INTO lead_followups
               (id, lead_id, channel, draft, status, approval_required)
               VALUES (?, ?, 'email', ?, 'pending', 1)`,
              [
                crypto.randomUUID(),
                resolvedLeadId,
                String(body.draft).trim().slice(0, 10000),
              ]
            );
          }
        }
      }
      res.json({ success: true, lead_id: resolvedLeadId, requested_lead_id: leadId, action, status });
    })
  );

  app.post(
    '/api/n8n/inbound/review',
    limiter,
    asyncHandler(async (req: Request, res: Response) => {
      if (!requireInbound(req, res)) return;

      const body = req.body || {};
      const empresaRef = String(body.empresa_id || body.slug || body.empresa_ref || '').trim();
      const rating = Number(body.rating);
      const comment = String(body.comment || body.comentario || '').trim();
      const name = String(body.name || body.nome || 'Cliente').trim().slice(0, 100);

      if (!empresaRef) {
        return res.status(400).json({ error: 'empresa_id ou slug obrigatório.' });
      }
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'rating deve ser 1–5.' });
      }

      const empresa = await findEmpresa(empresaRef);
      if (!empresa) {
        return res.status(404).json({ error: 'Empresa não encontrada.' });
      }

      const db = getDb();
      const now = new Date().toISOString();

      await db.run(
        `INSERT INTO reviews (empresa_id, name, rating, comment, "createdAt")
         VALUES (?, ?, ?, ?, ?)`,
        [empresa.id, name, rating, comment || null, now]
      );

      if (rating <= 3) {
        await queueN8nEvent('review.critica', {
          empresa_id: empresa.id,
          slug: empresa.slug,
          nome_empresa: empresa.nome_empresa,
          rating,
          name,
          comment: comment.slice(0, 500),
        }, { dedupeKey: 'n8n:review.critica:' + empresa.id + ':' + now });
      }

      res.status(201).json({ success: true, empresa_id: empresa.id });
    })
  );
}
