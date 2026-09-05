/**
 * Painel admin — métricas, faturamento, gestão de planos, status n8n.
 */
import type { Express, Response } from 'express';
import { getDb } from '../lib/db.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { PLANOS, type PlanDb } from '../stripeBilling.js';

const PRECO_MENSAL: Record<string, number> = {
  inicial: 69.9,
  pro: 109.9,
  ultra: 199.9,
  corporativo: 499.9,
  rei: 999.9,
};

async function ensureAdminColumns(db: any) {
  const cols = (await db.all(`PRAGMA table_info(empresas)`)).map((c: any) => c.name);
  const add = async (name: string, def: string) => {
    if (!cols.includes(name)) await db.exec(`ALTER TABLE empresas ADD COLUMN ${name} ${def}`);
  };
  await add('billing_cycle', `TEXT DEFAULT 'month'`);
  await add('cancel_at_period_end', `INTEGER DEFAULT 0`);
  await add('stripe_customer_id', `TEXT`);
  await add('stripe_subscription_id', `TEXT`);
  await add('bloqueado_motivo', `TEXT`);
}

function requireAdmin(req: AuthRequest, res: Response): boolean {
  if (!isAdminUser(req.user)) {
    res.status(403).json({ error: 'Acesso negado.' });
    return false;
  }
  return true;
}

export function mountAdminDashboardRoutes(app: Express) {
  app.get(
    '/api/admin/dashboard',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;
      const db = getDb();
      await ensureAdminColumns(db);

      const agora = new Date().toISOString();
      const empresas = await db.all(`SELECT * FROM empresas ORDER BY criado_em DESC LIMIT 500`);

      const ativos = empresas.filter(
        (e: any) =>
          (e.status === 'ativo' || e.status === 'trial' || e.status === 'teste') &&
          e.expira_em &&
          e.expira_em >= agora &&
          e.status !== 'bloqueado' &&
          e.status !== 'cancelado'
      );
      const trials = empresas.filter(
        (e: any) =>
          (e.status === 'trial' || e.status === 'teste' || e.plan === 'trial' || e.plan === 'teste') &&
          e.expira_em >= agora
      );
      const pagos = empresas.filter(
        (e: any) =>
          e.status === 'ativo' &&
          ['inicial', 'pro', 'ultra', 'corporativo', 'rei'].includes(String(e.plan || '').toLowerCase()) &&
          e.expira_em >= agora
      );
      const atrasados = empresas.filter((e: any) => {
        if (e.status === 'bloqueado' || e.status === 'cancelado') return false;
        if (!e.expira_em) return false;
        return e.expira_em < agora && (e.status === 'ativo' || e.status === 'trial' || e.status === 'teste');
      });
      const cancelamentoPendente = empresas.filter((e: any) => Number(e.cancel_at_period_end) === 1);

      let mrr = 0;
      const porPlano: Record<string, number> = {};
      for (const e of pagos) {
        const plan = String(e.plan || '').toLowerCase();
        const preco = PRECO_MENSAL[plan] || 0;
        // anual: MRR = preço mensal equivalente já na tabela display
        mrr += preco;
        porPlano[plan] = (porPlano[plan] || 0) + 1;
      }

      // tokens por empresa (top 10)
      const tokenRows = await db.all(
        `SELECT empresa_id, SUM(tokens) as total_tokens, COUNT(*) as eventos
         FROM ai_usage
         WHERE empresa_id IS NOT NULL
         GROUP BY empresa_id
         ORDER BY total_tokens DESC
         LIMIT 10`
      );
      const topTokens = [];
      for (const row of tokenRows || []) {
        const emp = empresas.find((x: any) => x.id === row.empresa_id);
        topTokens.push({
          empresa_id: row.empresa_id,
          nome_empresa: emp?.nome_empresa || row.empresa_id,
          cnpj: emp?.cnpj || null,
          plan: emp?.plan || null,
          total_tokens: Number(row.total_tokens || 0),
          eventos: Number(row.eventos || 0),
        });
      }

      const totalTokensMes = await db.get(
        `SELECT COALESCE(SUM(tokens),0) as t FROM ai_usage
         WHERE criado_em >= date('now', 'start of month')`
      );

      const reviewsMes = await db.get(
        `SELECT COUNT(*) as c FROM reviews
         WHERE createdAt >= date('now', 'start of month') AND IFNULL(is_test,0)=0`
      );

      res.json({
        gerado_em: new Date().toISOString(),
        kpis: {
          total_empresas: empresas.length,
          clientes_ativos: ativos.length,
          em_trial: trials.length,
          planos_pagos: pagos.length,
          faturas_atrasadas: atrasados.length,
          cancelamento_pendente: cancelamentoPendente.length,
          mrr_estimado_brl: Math.round(mrr * 100) / 100,
          arr_estimado_brl: Math.round(mrr * 12 * 100) / 100,
          tokens_mes: Number(totalTokensMes?.t || 0),
          reviews_mes: Number(reviewsMes?.c || 0),
        },
        por_plano: porPlano,
        top_tokens: topTokens,
        faturas_atrasadas: atrasados.map((e: any) => ({
          id: e.id,
          nome_empresa: e.nome_empresa,
          cnpj: e.cnpj,
          plan: e.plan,
          status: e.status,
          expira_em: e.expira_em,
          dias_atraso: Math.max(
            0,
            Math.floor((Date.now() - new Date(e.expira_em).getTime()) / 86400000)
          ),
        })),
        precos_referencia: PRECO_MENSAL,
      });
    })
  );

  app.get(
    '/api/admin/empresas',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;
      const db = getDb();
      await ensureAdminColumns(db);

      const rows = await db.all(`SELECT * FROM empresas ORDER BY criado_em DESC LIMIT 500`);
      const tokensByEmp = await db.all(
        `SELECT empresa_id, SUM(tokens) as total_tokens FROM ai_usage GROUP BY empresa_id`
      );
      const tokMap = new Map(
        (tokensByEmp || []).map((t: any) => [t.empresa_id, Number(t.total_tokens || 0)])
      );

      const agora = Date.now();
      const out = (rows || []).map((e: any) => {
        const exp = e.expira_em ? new Date(e.expira_em).getTime() : 0;
        const atrasado = exp > 0 && exp < agora && e.status !== 'cancelado' && e.status !== 'bloqueado';
        return {
          id: e.id,
          slug: e.slug,
          cnpj: e.cnpj,
          nome_empresa: e.nome_empresa,
          status: e.status,
          plan: e.plan,
          billing_cycle: e.billing_cycle || 'month',
          criado_em: e.criado_em,
          expira_em: e.expira_em,
          google_review_url: e.google_review_url || null,
          whatsapp_suporte: e.whatsapp_suporte || null,
          cancel_at_period_end: Number(e.cancel_at_period_end) === 1,
          stripe_customer_id: e.stripe_customer_id || null,
          total_tokens: tokMap.get(e.id) || 0,
          atrasado,
          mrr_estimado: PRECO_MENSAL[String(e.plan || '').toLowerCase()] || 0,
        };
      });
      res.json(out);
    })
  );

  /** Cancelar plano (teste ou pago) — bloqueia acesso. */
  app.post(
    '/api/admin/empresas/:id/cancelar',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;
      const db = getDb();
      await ensureAdminColumns(db);
      const id = String(req.params.id);
      const emp = await db.get(`SELECT * FROM empresas WHERE id = ?`, [id]);
      if (!emp) return res.status(404).json({ error: 'Empresa não encontrada.' });

      const imediato = req.body?.imediato !== false;
      const motivo = String(req.body?.motivo || 'Cancelado pelo admin').slice(0, 200);

      if (imediato) {
        await db.run(
          `UPDATE empresas SET status = 'cancelado', cancel_at_period_end = 0,
           bloqueado_motivo = ?, expira_em = ? WHERE id = ?`,
          [motivo, new Date().toISOString(), id]
        );
      } else {
        await db.run(
          `UPDATE empresas SET cancel_at_period_end = 1, bloqueado_motivo = ? WHERE id = ?`,
          [motivo, id]
        );
      }

      res.json({
        success: true,
        imediato,
        status: imediato ? 'cancelado' : emp.status,
        mensagem: imediato
          ? 'Plano cancelado imediatamente.'
          : 'Cancelamento ao fim do período marcado.',
      });
    })
  );

  /** Renovar / estender: month | year | dias número */
  app.post(
    '/api/admin/empresas/:id/renovar',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;
      const db = getDb();
      await ensureAdminColumns(db);
      const id = String(req.params.id);
      const emp = await db.get(`SELECT * FROM empresas WHERE id = ?`, [id]);
      if (!emp) return res.status(404).json({ error: 'Empresa não encontrada.' });

      const ciclo = String(req.body?.ciclo || req.body?.period || 'month').toLowerCase();
      let dias = 30;
      if (ciclo === 'year' || ciclo === 'anual' || ciclo === 'ano') dias = 365;
      else if (ciclo === 'month' || ciclo === 'mensal' || ciclo === 'mes') dias = 30;
      else if (Number(ciclo) > 0) dias = Math.min(730, Number(ciclo));
      else if (Number(req.body?.dias) > 0) dias = Math.min(730, Number(req.body.dias));

      const plan =
        req.body?.plan && String(req.body.plan).toLowerCase() !== 'trial'
          ? String(req.body.plan).toLowerCase()
          : String(emp.plan || 'inicial').toLowerCase() === 'trial' ||
              String(emp.plan || '').toLowerCase() === 'teste'
            ? 'inicial'
            : String(emp.plan || 'inicial').toLowerCase();

      const base =
        emp.expira_em && new Date(emp.expira_em).getTime() > Date.now()
          ? new Date(emp.expira_em)
          : new Date();
      base.setDate(base.getDate() + dias);

      await db.run(
        `UPDATE empresas SET
          status = 'ativo',
          plan = ?,
          billing_cycle = ?,
          expira_em = ?,
          cancel_at_period_end = 0,
          bloqueado_motivo = NULL
         WHERE id = ?`,
        [plan, dias >= 360 ? 'year' : 'month', base.toISOString(), id]
      );

      res.json({
        success: true,
        plan,
        expira_em: base.toISOString(),
        dias_adicionados: dias,
        mensagem: `Acesso estendido em ${dias} dia(s). Novo vencimento: ${base.toLocaleDateString('pt-BR')}.`,
      });
    })
  );

  /** Status discreto das integrações (n8n / maps / wpp). */
  app.get(
    '/api/admin/integracoes',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;
      const db = getDb();

      const n8nUrl =
        process.env.N8N_WEBHOOK_URL ||
        process.env.N8N_STATUS_URL ||
        process.env.N8N_BASE_URL ||
        '';
      let n8n_ok: boolean | null = null;
      let n8n_detail = 'URL não configurada (N8N_WEBHOOK_URL / N8N_STATUS_URL)';
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
          n8n_ok = r.ok || r.status === 404 || r.status === 405; // endpoint existe
          n8n_detail = `HTTP ${r.status}`;
        } catch (e: any) {
          n8n_ok = false;
          n8n_detail = e?.message || 'Falha de conexão';
        }
      }

      const mapsKey = Boolean(
        process.env.GOOGLE_MAPS_API_KEY?.trim() ||
          process.env.GOOGLE_PLACES_API_KEY?.trim() ||
          process.env.GOOGLE_API_KEY?.trim()
      );
      const comGoogle = await db.get(
        `SELECT COUNT(*) as c FROM empresas WHERE google_review_url IS NOT NULL AND google_review_url != ''`
      );
      const comWpp = await db.get(
        `SELECT COUNT(*) as c FROM empresas WHERE whatsapp_suporte IS NOT NULL AND whatsapp_suporte != ''`
      );

      const wppApi = Boolean(
        process.env.WHATSAPP_TOKEN?.trim() ||
          process.env.WHATSAPP_API_URL?.trim() ||
          process.env.ZAPI_TOKEN?.trim()
      );

      res.json({
        n8n: {
          configurado: Boolean(n8nUrl),
          url_mascarada: n8nUrl
            ? n8nUrl.replace(/^(https?:\/\/[^/]+).*/, '$1/…')
            : null,
          ok: n8n_ok,
          detalhe: n8n_detail,
        },
        google_maps: {
          api_key_env: mapsKey,
          empresas_com_link_google: Number(comGoogle?.c || 0),
          ok: mapsKey || Number(comGoogle?.c || 0) > 0,
          detalhe: mapsKey
            ? 'Chave de API presente no .env'
            : Number(comGoogle?.c || 0) > 0
              ? 'Sem chave global; há links Google nas empresas (captação manual/n8n)'
              : 'Sem chave e nenhum link Google cadastrado',
        },
        whatsapp: {
          api_env: wppApi,
          empresas_com_wpp: Number(comWpp?.c || 0),
          ok: Number(comWpp?.c || 0) > 0 || wppApi,
          detalhe: wppApi
            ? 'Integração WPP configurada no .env'
            : `${Number(comWpp?.c || 0)} empresa(s) com número de suporte`,
        },
        gerado_em: new Date().toISOString(),
      });
    })
  );

  app.get(
    '/api/admin/reviews',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;
      const rows = await getDb().all(
        `SELECT r.*, e.nome_empresa
         FROM reviews r
         LEFT JOIN empresas e ON e.id = r.empresa_id
         ORDER BY r.createdAt DESC LIMIT 100`
      );
      res.json(rows);
    })
  );
}
