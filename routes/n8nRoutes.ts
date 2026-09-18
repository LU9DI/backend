/**
 * Rotas n8n:
 *   GET  /api/n8n/status
 *   POST /api/n8n/ping          — testa webhook de saída
 *   POST /api/n8n/inbound/lead  — n8n envia lead captado (Maps etc.)
 *   POST /api/n8n/inbound/review — n8n envia avaliação externa
 */
import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { getDb } from '../lib/db.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  n8nConfigured,
  n8nStatus,
  notifyN8n,
  verifyInboundSecret,
} from '../lib/n8n.js';
import { ensureRuntimeSchema } from '../lib/schemaEnsure.js';
import { qualifyLead } from '../services/leadAutomation.js';

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
      const ok = await notifyN8n('ping', { message: 'Filtra.AI connectivity check' });
      res.json({ success: ok, configured: true });
    })
  );

  /** Lead captado pelo n8n (Google Maps / formulário / etc.) */
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
      await ensureRuntimeSchema(db);

      // Tabela simples de leads (idempotente)
      await db.exec(`
        CREATE TABLE IF NOT EXISTS leads (
          id TEXT PRIMARY KEY,
          nome_empresa TEXT,
          email TEXT,
          telefone TEXT,
          fonte TEXT,
          maps_url TEXT,
          raw_json TEXT,
          criado_em TEXT NOT NULL,
          status TEXT DEFAULT 'new',
          score INTEGER,
          qualification TEXT,
          ai_reason TEXT
        )
      `);
      // Compatibilidade com instalações que já possuem a tabela leads.
      for (const stmt of [
        'ALTER TABLE leads ADD COLUMN status TEXT DEFAULT \'new\'',
        'ALTER TABLE leads ADD COLUMN score INTEGER',
        'ALTER TABLE leads ADD COLUMN qualification TEXT',
        'ALTER TABLE leads ADD COLUMN ai_reason TEXT',
      ]) {
        try { await db.exec(stmt); } catch { /* coluna já existe */ }
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
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

      // Primeiro evento: o lead entrou no sistema.
      notifyN8n('lead.captured', {
        lead_id: id,
        nome_empresa: nome,
        email,
        telefone,
        fonte,
      }).catch(() => undefined);

      // Segundo estágio: qualificação automática pela IA.
      // Falha de IA nunca impede a entrada do lead.
      const qualification = await qualifyLead({
        nome_empresa: nome,
        email,
        telefone,
        fonte,
        maps_url: mapsUrl,
      });

      if (qualification) {
        await db.run(
          `UPDATE leads
           SET status = ?, score = ?, qualification = ?, ai_reason = ?
           WHERE id = ?`,
          ['qualified', qualification.score, qualification.qualification, qualification.reason, id]
        );

        notifyN8n('lead.qualified', {
          lead_id: id,
          nome_empresa: nome,
          email,
          telefone,
          fonte,
          score: qualification.score,
          qualification: qualification.qualification,
          reason: qualification.reason,
        }).catch(() => undefined);

        // Segundo sinal de automação: leads com potencial suficiente entram
        // na fila de follow-up. O evento não envia mensagem por conta própria.
        if (qualification.score >= 40) {
          notifyN8n('lead.followup.requested', {
            lead_id: id,
            nome_empresa: nome,
            email,
            telefone,
            fonte,
            score: qualification.score,
            qualification: qualification.qualification,
            reason: qualification.reason,
            action: 'create_crm_followup',
          }).catch(() => undefined);
        }
      }

      res.status(201).json({
        success: true,
        lead_id: id,
        qualification: qualification || null,
      });
    })
  );

  /** Review vinda do n8n (scraping / outro canal) */
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

      const db = getDb();
      const empresa =
        (await db.get(`SELECT * FROM empresas WHERE id = ?`, [empresaRef])) ||
        (await db.get(`SELECT * FROM empresas WHERE slug = ?`, [empresaRef]));

      if (!empresa) {
        return res.status(404).json({ error: 'Empresa não encontrada.' });
      }

      await db.run(
        `INSERT INTO reviews (empresa_id, name, rating, comment, createdAt)
         VALUES (?, ?, ?, ?, datetime('now'))`,
        [empresa.id, name, rating, comment || null]
      );

      if (rating <= 3) {
        notifyN8n('review.critical', {
          empresa_id: empresa.id,
          slug: empresa.slug,
          nome_empresa: empresa.nome_empresa,
          rating,
          name,
          comment: comment.slice(0, 500),
        }).catch(() => undefined);
      }

      res.status(201).json({ success: true, empresa_id: empresa.id });
    })
  );
}
