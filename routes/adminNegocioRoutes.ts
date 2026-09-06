/**
 * Gestão de negócio no admin:
 * - Preços dos 5 planos + desconto anual
 * - Monitor IA (requisições / rate limit Groq)
 * - Status operacional WhatsApp (via n8n)
 */
import type { Express, Response } from 'express';
import { getDb } from '../lib/db.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { listPlanPrices, updatePlanPrices, ensurePlanPricingSchema } from '../lib/planPricing.js';
import { getAiMonitorSnapshot } from '../lib/aiMonitor.js';
import { applyDbPricesToPlanos, PLANOS } from '../stripeBilling.js';

function requireAdmin(req: AuthRequest, res: Response): boolean {
  if (!isAdminUser(req.user)) {
    res.status(403).json({ error: 'Acesso negado.' });
    return false;
  }
  return true;
}

async function probeWhatsApp(): Promise<{
  ok: boolean | null;
  detalhe: string;
  fonte: string;
  configurado: boolean;
}> {
  const statusUrl =
    process.env.N8N_WHATSAPP_STATUS_URL ||
    process.env.WHATSAPP_STATUS_URL ||
    process.env.N8N_STATUS_URL ||
    '';
  const hasToken = Boolean(
    process.env.WHATSAPP_TOKEN?.trim() ||
      process.env.ZAPI_TOKEN?.trim() ||
      process.env.WHATSAPP_API_URL?.trim()
  );

  if (!statusUrl && !hasToken) {
    return {
      ok: null,
      detalhe: 'Configure N8N_WHATSAPP_STATUS_URL ou WHATSAPP_TOKEN',
      fonte: 'env',
      configurado: false,
    };
  }

  if (statusUrl) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4500);
      const r = await fetch(statusUrl, {
        method: 'GET',
        signal: ctrl.signal,
        headers: process.env.N8N_API_KEY
          ? { 'X-N8N-API-KEY': process.env.N8N_API_KEY }
          : undefined,
      });
      clearTimeout(t);
      let bodyOk: boolean | null = null;
      try {
        const j = await r.json();
        if (typeof j?.ok === 'boolean') bodyOk = j.ok;
        if (typeof j?.connected === 'boolean') bodyOk = j.connected;
        if (typeof j?.status === 'string') {
          const s = j.status.toLowerCase();
          bodyOk = s === 'connected' || s === 'online' || s === 'ok' || s === 'ready';
        }
      } catch {
        /* não JSON */
      }
      const ok = bodyOk != null ? bodyOk : r.ok || r.status === 404 || r.status === 405;
      return {
        ok,
        detalhe: bodyOk != null ? `n8n status body` : `HTTP ${r.status}`,
        fonte: 'n8n_status_url',
        configurado: true,
      };
    } catch (e: any) {
      return {
        ok: false,
        detalhe: e?.message || 'Falha ao consultar n8n/WhatsApp',
        fonte: 'n8n_status_url',
        configurado: true,
      };
    }
  }

  return {
    ok: hasToken ? true : null,
    detalhe: hasToken
      ? 'Credencial WhatsApp presente no .env (sem URL de status n8n)'
      : 'Sem status',
    fonte: 'env',
    configurado: hasToken,
  };
}

export function mountAdminNegocioRoutes(app: Express) {
  app.get(
    '/api/admin/planos-precos',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;
      const data = await listPlanPrices(getDb());
      res.json({
        ...data,
        nota:
          'Valores em BRL. O desconto anual agressivo recalcula o mensal-equivalente do anual a partir do mensal.',
      });
    })
  );

  app.put(
    '/api/admin/planos-precos',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;
      const body = req.body || {};
      const updates = Array.isArray(body.planos) ? body.planos : [];
      const discount =
        body.annual_discount_pct != null ? Number(body.annual_discount_pct) : null;
      const data = await updatePlanPrices(updates, discount, getDb());
      try {
        await applyDbPricesToPlanos(PLANOS as any, getDb());
      } catch {
        /* */
      }
      res.json({ success: true, ...data });
    })
  );

  app.get(
    '/api/admin/ai-monitor',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;
      const snap = await getAiMonitorSnapshot(getDb());
      res.json(snap);
    })
  );

  app.get(
    '/api/admin/whatsapp-status',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;
      const db = getDb();
      const wpp = await probeWhatsApp();

      const comWpp = await db.get(
        `SELECT COUNT(*) as c FROM empresas
         WHERE whatsapp_suporte IS NOT NULL AND whatsapp_suporte != ''`
      );

      // eventos recentes n8n com whatsapp no tipo
      let eventos: any[] = [];
      try {
        eventos = await db.all(
          `SELECT * FROM webhook_events
           WHERE source IN ('n8n','whatsapp')
             AND (event_type LIKE '%wpp%' OR event_type LIKE '%whatsapp%'
                  OR payload_summary LIKE '%whatsapp%' OR detail LIKE '%whatsapp%')
           ORDER BY id DESC LIMIT 10`
        );
      } catch {
        /* tabela pode não existir ainda */
      }

      res.json({
        gerado_em: new Date().toISOString(),
        canal: {
          ok: wpp.ok,
          configurado: wpp.configurado,
          detalhe: wpp.detalhe,
          fonte: wpp.fonte,
          cor: wpp.ok === true ? 'verde' : wpp.ok === false ? 'vermelho' : 'cinza',
        },
        empresas_com_numero: Number(comWpp?.c || 0),
        eventos_recentes: eventos || [],
        dica: 'No n8n, exponha um webhook de status (connected/ok) em N8N_WHATSAPP_STATUS_URL.',
      });
    })
  );

  /** Snapshot único para a tela de negócio */
  app.get(
    '/api/admin/negocio',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;
      const db = getDb();
      await ensurePlanPricingSchema(db);
      const precos = await listPlanPrices(db);
      const ai = await getAiMonitorSnapshot(db);
      const wpp = await probeWhatsApp();
      res.json({
        gerado_em: new Date().toISOString(),
        precos,
        ia: ai,
        whatsapp: {
          ok: wpp.ok,
          configurado: wpp.configurado,
          detalhe: wpp.detalhe,
          fonte: wpp.fonte,
          cor: wpp.ok === true ? 'verde' : wpp.ok === false ? 'vermelho' : 'cinza',
        },
      });
    })
  );
}
