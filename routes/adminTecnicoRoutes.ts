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

      const cols = (await db.all(`PRAGMA table_info(reviews)`)).map((c: any) => c.name);
      if (!cols.includes('client_whatsapp')) {
        try {
          await db.exec(`ALTER TABLE reviews ADD COLUMN client_whatsapp TEXT`);
        } catch {
          /* */
        }
      }

      const criticas = await db.all(
        `SELECT r.id, r.name, r.rating, r.comment, r.ai_reply, r.ai_tags, r.createdAt,
                r.client_whatsapp, r.empresa_id, r.origin,
                e.nome_empresa, e.plan, e.slug
         FROM reviews r
         LEFT JOIN empresas e ON e.id = r.empresa_id
         WHERE r.rating <= 3 AND IFNULL(r.is_test, 0) = 0
         ORDER BY r.createdAt DESC
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
          client_whatsapp: r.client_whatsapp || null,
          createdAt: r.createdAt,
          empresa_id: r.empresa_id,
          nome_empresa: r.nome_empresa || r.empresa_id,
          plan: r.plan,
          slug: r.slug,
          origin: r.origin || 'publico',
          tem_ia: Boolean(r.ai_reply),
        };
      });

      const comIa = criticasFmt.filter((c: any) => c.tem_ia).length;
      const semIa = criticasFmt.length - comIa;

      const pdfLogs = await recentPdfLogs(db, 40);
      const pdfSince = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const pdfStats = await db.get(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as ok_count,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as err_count,
           SUM(CASE WHEN status = 'forbidden' THEN 1 ELSE 0 END) as forbidden_count,
           SUM(CASE WHEN auth_mode LIKE 'jwt%' THEN 1 ELSE 0 END) as jwt_count,
           MAX(created_at) as last_at
         FROM pdf_generation_log
         WHERE created_at >= ?`,
        [pdfSince]
      );

      const pdfOk24h =
        Number(pdfStats?.total || 0) === 0
          ? null
          : Number(pdfStats?.err_count || 0) === 0 && Number(pdfStats?.ok_count || 0) > 0;

      let retry: any = { by_status: {}, pending_due: 0 };
      try {
        retry = await retryQueueStats(db);
      } catch {
        /* */
      }

      res.json({
        gerado_em: new Date().toISOString(),
        webhooks: {
          stripe: {
            configurado: stripeConfigured(),
            ok: stripeConfigured() ? stripeLast24hOk : false,
            detalhe: !stripeConfigured()
              ? 'STRIPE_SECRET_KEY ausente'
              : stripeHealth.total === 0
                ? 'Nenhum evento nas últimas 24h (aguardando webhooks)'
                : `${stripeHealth.ok} ok / ${stripeHealth.errors} erro(s) em 24h`,
            last_at: stripeHealth.last_at,
            last_age: ageLabel(stripeHealth.last_at),
            stats_24h: stripeHealth,
            eventos: (allEvents || []).filter((e: any) => e.source === 'stripe').slice(0, 20),
          },
          n8n: {
            configurado: Boolean(n8nUrl) || n8nHealth.total > 0,
            url_mascarada: n8nUrl
              ? n8nUrl.replace(/^(https?:\/\/[^/]+).*/, '$1/…')
              : null,
            inbound: '/api/webhook/n8n',
            ok: n8nLast24hOk !== null ? n8nLast24hOk : n8nPingOk,
            ping_ok: n8nPingOk,
            detalhe:
              n8nHealth.total > 0
                ? `${n8nHealth.ok} eventos ok / ${n8nHealth.errors} erro(s) em 24h · ping: ${n8nPingDetail}`
                : n8nPingDetail,
            last_at: n8nHealth.last_at,
            last_age: ageLabel(n8nHealth.last_at),
            stats_24h: n8nHealth,
            eventos: (allEvents || []).filter((e: any) => e.source === 'n8n').slice(0, 20),
          },
          paypal: {
            configurado: paypalConfigured(),
            webhook_id: paypalWebhookConfigured(),
            ok: !paypalConfigured() ? false : paypalLast24hOk,
            detalhe: !paypalConfigured()
              ? 'PAYPAL_CLIENT_ID/SECRET ausentes'
              : !paypalWebhookConfigured()
                ? 'PAYPAL_WEBHOOK_ID ausente (verify em prod)'
                : paypalHealth.total === 0
                  ? 'Nenhum evento PayPal em 24h'
                  : `${paypalHealth.ok} ok / ${paypalHealth.errors} erro(s) em 24h`,
            last_at: paypalHealth.last_at,
            last_age: ageLabel(paypalHealth.last_at),
            stats_24h: paypalHealth,
            eventos: (allEvents || []).filter((e: any) => e.source === 'paypal').slice(0, 20),
          },
          mercadopago: {
            configurado: mpConfigured(),
            inbound: '/api/webhook/mercadopago',
            ok: !mpConfigured() ? false : mpLast24hOk,
            detalhe: !mpConfigured()
              ? 'MP_ACCESS_TOKEN ausente'
              : mpHealth.total === 0
                ? 'Nenhum evento Pix/MP em 24h'
                : `${mpHealth.ok} ok / ${mpHealth.errors} erro(s) em 24h`,
            last_at: mpHealth.last_at,
            last_age: ageLabel(mpHealth.last_at),
            stats_24h: mpHealth,
            eventos: (allEvents || [])
              .filter((e: any) => e.source === 'mercadopago')
              .slice(0, 20),
          },
        },
        criticas_retidas: {
          total: criticasFmt.length,
          com_resposta_ia: comIa,
          sem_resposta_ia: semIa,
          items: criticasFmt,
        },
        pdf: {
          ok: pdfOk24h,
          detalhe:
            Number(pdfStats?.total || 0) === 0
              ? 'Nenhuma geração nas últimas 24h'
              : `${pdfStats?.ok_count || 0} ok / ${pdfStats?.err_count || 0} erro(s) / ${pdfStats?.forbidden_count || 0} bloqueado(s) · JWT: ${pdfStats?.jwt_count || 0}`,
          last_at: pdfStats?.last_at || null,
          last_age: ageLabel(pdfStats?.last_at || null),
          stats_24h: {
            total: Number(pdfStats?.total || 0),
            ok: Number(pdfStats?.ok_count || 0),
            errors: Number(pdfStats?.err_count || 0),
            forbidden: Number(pdfStats?.forbidden_count || 0),
            jwt: Number(pdfStats?.jwt_count || 0),
          },
          logs: pdfLogs || [],
        },
        retry_queue: retry,
        sistema: {
          smtp: smtpConfigured(),
          stripe: stripeConfigured(),
          paypal: paypalConfigured(),
          pix: mpConfigured(),
          groq: Boolean(process.env.GROQ_API_KEY?.trim()),
          gemini: Boolean(
            process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_AI_API_KEY?.trim()
          ),
          jobs_secret: Boolean(process.env.JOBS_SECRET?.trim()),
        },
      });
    })
  );

  app.get(
    '/api/admin/criticas-retidas',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 80));
      const rows = await getDb().all(
        `SELECT r.id, r.name, r.rating, r.comment, r.ai_reply, r.ai_tags, r.createdAt,
                r.client_whatsapp, r.empresa_id, e.nome_empresa, e.plan
         FROM reviews r
         LEFT JOIN empresas e ON e.id = r.empresa_id
         WHERE r.rating <= 3 AND IFNULL(r.is_test, 0) = 0
         ORDER BY r.createdAt DESC
         LIMIT ?`,
        [limit]
      );
      res.json({ items: rows || [], total: (rows || []).length });
    })
  );
}
