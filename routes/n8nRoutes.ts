/** Rotas n8n: status, ping, inbound lead/review. */
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
        : 'Defina N8N_WEBHOOK_URL no Render.',
    });
  });

  app.post(
    '/api/n8n/ping',
    limiter,
    asyncHandler(async (_req: Request, res: Response) => {
      if (!n8nConfigured()) {
        return res.status(503).json({ error: 'N8N_WEBHOOK_URL não configurado.', configured: false });
      }
      const ok = await notifyN8n('ping', { message: 'Filtra.AI connectivity check' });
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
        return res.status(400).json({ error: 'Informe nome_empresa, email ou telefone.' });
      }

      const db = getDb();
      await ensureRuntimeSchema(db);
      await db.exec(`
        CREATE TABLE IF NOT EXISTS leads (
          id TEXT PRIMARY KEY,
          nome_empresa TEXT,
          email TEXT,
          telefone TEXT,
          fonte TEXT,
          maps_url TEXT,
          raw_json TEXT,
          criado_em TEXT NOT NULL
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
          new Date().toISOString(),
        ]
      );

      notifyN8n('lead.captured', {
        lead_id: id,
        nome_empresa: nome,
        email,
        telefone,
        fonte,
      }).catch(() => undefined);

      res.status(201).json({ success: true, lead_id: id });
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

      if (!empresaRef) return res.status(400).json({ error: 'empresa_id ou slug obrigatório.' });
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'rating deve ser 1–5.' });
      }

      const db = getDb();
      const empresa =
        (await db.get(`SELECT * FROM empresas WHERE id = ?`, [empresaRef])) ||
        (await db.get(`SELECT * FROM empresas WHERE slug = ?`, [empresaRef]));
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });

      await db.run(
        `INSERT INTO reviews (empresa_id, name, rating, comment, createdAt)
         VALUES (?, ?, ?, ?, datetime('now'))`,
        [empresa.id, name, rating, comment || null]
      );

      if (rating <= 3) {
        notifyN8n('review.critical', {
          empresa_id: empresa.id,
          slug: empresa.slug,
          rating,
          name,
          comment: comment.slice(0, 500),
        }).catch(() => undefined);
      }

      res.status(201).json({ success: true, empresa_id: empresa.id });
    })
  );
}
