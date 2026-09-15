/**
 * Área técnica do admin:
 * - Status webhooks Stripe / n8n / PayPal / Mercado Pago (Pix)
 * - Auditoria de críticas retidas
 * - Status PDF + fila de retry
 */
import type { Express, Request, Response } from 'express';
import { getDb } from '../lib/db.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  ensureOpsTables,
  logWebhookEvent,
  recentPdfLogs,
  webhookHealth,
} from '../lib/opsLog.js';
import { stripeConfigured } from '../stripeBilling.js';
import { paypalConfigured, paypalWebhookConfigured } from '../lib/paypal.js';
import { mpConfigured } from '../lib/mercadopago.js';
import { smtpConfigured } from '../lib/mailer.js';
import { retryQueueStats } from '../lib/retryQueue.js';

function requireAdmin(req: AuthRequest, res: Response): boolean {
  if (!isAdminUser(req.user)) {
    res.status(403).json({ error: 'Acesso negado.' });
    return false;
  }
  return true;
}

function ageLabel(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min} min atrás`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h atrás`;
  return `${Math.floor(h / 24)}d atrás`;
}

export function mountAdminTecnicoRoutes(app: Express) {
  app.post(
    '/api/webhook/n8n',
    asyncHandler(async (req: Request, res: Response) => {
      const db = getDb();
      const secret = process.env.N8N_WEBHOOK_SECRET?.trim();
      if (secret) {
        const hdr =
          String(req.headers['x-n8n-secret'] || '') ||
          String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
        if (hdr !== secret) {
          await logWebhookEvent(db, {
            source: 'n8n',
            event_type: 'auth_failed',
            status: 'error',
            detail: 'Secret inválido',
          });
          return res.status(401).json({ error: 'Unauthorized' });
        }
      }

      const body = req.body || {};
      const eventType = String(body.event || body.type || body.action || 'ping').slice(0, 80);
      const summary = JSON.stringify({
        place_id: body.place_id || body.placeId || null,
        empresa_id: body.empresa_id || null,
        reviews_count: body.reviews?.length || body.count || null,
        keys: Object.keys(body).slice(0, 12),
      }).slice(0, 400);

      await logWebhookEvent(db, {
        source: 'n8n',
        event_type: eventType,
        status: 'ok',
        detail: 'Recebido',
        payload_summary: summary,
      });

      res.json({ ok: true, received_at: new Date().toISOString() });
    })
  );

  app.get(
    '/api/admin/tecnico',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;
      const db = getDb();
      await ensureOpsTables(db);

      const stripeHealth = await webhookHealth(db, 'stripe', 24);
      const n8nHealth = await webhookHealth(db, 'n8n', 24);
      const paypalHealth = await webhookHealth(db, 'paypal', 24);
      const mpHealth = await webhookHealth(db, 'mercadopago', 24);

      const allEvents = await db.all(
        `SELECT * FROM webhook_events ORDER BY id DESC LIMIT 80`
      );

      const n8nUrl =
        process.env.N8N_WEBHOOK_URL ||
        process.env.N8N_STATUS_URL ||
        process.env.N8N_BASE_URL ||
        '';
      let n8nPingOk: boolean | null = null;
      let n8nPingDetail = n8nUrl ? 'Sem teste de ping' : 'N8N_WEBHOOK_URL não configurada';
      if (n8nUrl) {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 4000);
          const r = await fetch(n8nUrl, {
            method: 'GET',
            signal: ctrl.signal,
            headers: process.env.N8N_API_KEY
              ? { 'X-N8N-API-KEY': process.env.N8N_API_KEY }
              : undefined,
          });
          clearTimeout(t);
          n8nPingOk = r.ok || r.status === 404 || r.status === 405;
          n8nPingDetail = `HTTP ${r.status}`;
        } catch (e: any) {
          n8nPingOk = false;
          n8nPingDetail = e?.message || 'Falha de conexão';
        }
      }

      const stripeLast24hOk =
        stripeHealth.total === 0 ? null : stripeHealth.errors === 0 && stripeHealth.ok > 0;
      const n8nLast24hOk =
        n8nHealth.total === 0 ? null : n8nHealth.errors === 0 && n8nHealth.ok > 0;
      const paypalLast24hOk =
        paypalHealth.total === 0 ? null : paypalHealth.errors === 0 && paypalHealth.ok > 0;
      const mpLast24hOk =
        mpHealth.total === 0 ? null : mpHealth.errors === 0 && mpHealth.ok > 0;

      const cols = (await db.all(`SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'reviews'`)).map((c: any) => c.name);
      if (!cols.includes('client_whatsapp')) {
        try {
          await db.exec(`ALTER TABLE reviews ADD COLUMN client_whatsapp TEXT`);
        } catch {
          /* */
        }
      }

      const criticas = await db.all(
        `SELECT r.id, r.name, r.rating, r.comment, r.ai_reply, r.ai_tags,
                r.createdat AS "createdAt", r.client_whatsapp, r.empresa_id, r.origin,
                e.nome_empresa, e.plan, e.slug
         FROM reviews r
         LEFT JOIN empresas e ON e.id = r.empresa_id
         WHERE r.rating <= 3 AND COALESCE(r.is_test, 0) = 0
         ORDER BY r.createdat DESC
         LIMIT 80`
      );

      const criticasFmt = (criticas || []).map((r: any) => {
        let tags: string[] = [];
        if (r.ai_tags) {
          try {
            const p = JSON.parse(r.ai_tags);
            if (Array.isArray(p)) tags = p.map(String);
          } catch {
            tags = [];
          }
        }
        return {
          id: r.id,
          name: r.name,
          rating: r.rating,
          comment: r.comment,
          ai_reply: r.ai_reply,
          ai_tags: tags,
          createdAt: r.createdAt,
          client_whatsapp: r.client_whatsapp,
          empresa_id: r.empresa_id,
          origin: r.origin,
          nome_empresa: r.nome_empresa,
          plan: r.plan,
          slug: r.slug,
        };
      });

      const retry = await retryQueueStats(db);
      const pdfLogs = await recentPdfLogs(db, 20);

      res.json({
        ok: true,
        integrations: {
          stripe: stripeConfigured(),
          paypal: paypalConfigured(),
          paypal_webhook: paypalWebhookConfigured(),
          pix: mpConfigured(),
          smtp: smtpConfigured(),
          n8n: Boolean(n8nUrl),
        },
        health24h: {
          stripe: stripeLast24hOk,
          n8n: n8nLast24hOk,
          paypal: paypalLast24hOk,
          pix: mpLast24hOk,
        },
        n8n_ping: { ok: n8nPingOk, detail: n8nPingDetail },
        events: allEvents,
        criticas: criticasFmt,
        retry,
        pdf: pdfLogs,
      });
    })
  );
}
