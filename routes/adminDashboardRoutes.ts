/**
 * Painel admin — métricas, faturamento, gestão de planos, status n8n, Stripe, CSV.
 */
import type { Express, Response } from 'express';
import { getDb } from '../lib/db.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { listStripeInvoices } from '../lib/stripeInvoices.js';

const PRECO_MENSAL: Record<string, number> = {
  inicial: 69.9,
  pro: 109.9,
  ultra: 199.9,
  corporativo: 499.9,
  rei: 999.9,
};

async function ensureAdminColumns(db: any) {
  const cols = [
    ['billing_cycle', `TEXT DEFAULT 'month'`],
    ['cancel_at_period_end', `INTEGER DEFAULT 0`],
    ['stripe_customer_id', `TEXT`],
    ['stripe_subscription_id', `TEXT`],
    ['bloqueado_motivo', `TEXT`],
  ];
  for (const [name, def] of cols) {
    try {
      await db.exec(`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS ${name} ${def}`);
    } catch {
      try {
        await db.exec(`ALTER TABLE empresas ADD COLUMN ${name} ${def}`);
      } catch {
        /* já existe */
      }
    }
  }
}

function requireAdmin(req: AuthRequest, res: Response): boolean {
  if (!isAdminUser(req.user)) {
    res.status(403).json({ error: 'Acesso negado.' });
    return false;
  }
  return true;
}

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseCicloDias(body: any): { dias: number; ciclo: 'month' | 'year' } {
  const rawCiclo = String(body?.ciclo || body?.period || '').toLowerCase().trim();
  const rawDias = Number(body?.dias);

  if (rawCiclo === 'year' || rawCiclo === 'anual' || rawCiclo === 'ano' || rawCiclo === '1y') {
    return { dias: 365, ciclo: 'year' };
  }
  if (rawCiclo === 'month' || rawCiclo === 'mensal' || rawCiclo === 'mes' || rawCiclo === '1m') {
    return { dias: 30, ciclo: 'month' };
  }
  if (Number.isFinite(rawDias) && rawDias > 0) {
    const dias = Math.min(730, Math.floor(rawDias));
    return { dias, ciclo: dias >= 360 ? 'year' : 'month' };
  }
  return { dias: 30, ciclo: 'month' };
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
          String(e.expira_em) >= agora &&
          e.status !== 'bloqueado' &&
          e.status !== 'cancelado'
      );
      const trials = empresas.filter(
        (e: any) =>
          (e.status === 'trial' || e.status === 'teste' || e.plan === 'trial' || e.plan === 'teste') &&
          e.expira_em &&
          String(e.expira_em) >= agora
      );
      const pagos = empresas.filter(
        (e: any) =>
          e.status === 'ativo' &&
          ['inicial', 'pro', 'ultra', 'corporativo', 'rei'].includes(String(e.plan || '').toLowerCase()) &&
          e.expira_em &&
          String(e.expira_em) >= agora
      );
      const atrasados = empresas.filter((e: any) => {
        if (e.status === 'bloqueado' || e.status === 'cancelado') return false;
        if (!e.expira_em) return false;
        return (
          String(e.expira_em) < agora &&
          (e.status === 'ativo' || e.status === 'trial' || e.status === 'teste')
        );
      });
      const cancelamentoPendente = empresas.filter((e: any) => Number(e.cancel_at_period_end) === 1);

      let mrr = 0;
      const porPlano: Record<string, number> = {};
      for (const e of pagos) {
        const plan = String(e.plan || '').toLowerCase();
        const preco = PRECO_MENSAL[plan] || 0;
        mrr += preco;
        porPlano[plan] = (porPlano[plan] || 0) + 1;
      }

      let tokenRows: any[] = [];
      try {
        tokenRows = await db.all(
          `SELECT empresa_id, SUM(tokens) as total_tokens, COUNT(*) as eventos
           FROM ai_usage
           WHERE empresa_id IS NOT NULL
           GROUP BY empresa_id
           ORDER BY total_tokens DESC
           LIMIT 10`
        );
      } catch {
        tokenRows = [];
      }
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

      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const monthIso = monthStart.toISOString();

      let totalTokensMes: any = { t: 0 };
      try {
        totalTokensMes = await db.get(
          `SELECT COALESCE(SUM(tokens),0) as t FROM ai_usage WHERE criado_em >= ?`,
          [monthIso]
        );
      } catch {
        /* */
      }

      let reviewsMes: any = { c: 0 };
      try {
        reviewsMes = await db.get(
          `SELECT COUNT(*) as c FROM reviews
           WHERE createdAt >= ? AND COALESCE(is_test,0)=0`,
          [monthIso]
        );
      } catch {
        /* */
      }

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
      let tokensByEmp: any[] = [];
      try {
        tokensByEmp = await db.all(
          `SELECT empresa_id, SUM(tokens) as total_tokens FROM ai_usage GROUP BY empresa_id`
        );
      } catch {
        tokensByEmp = [];
      }
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
          painel_path: `/painel/${e.slug || e.id}`,
        };
      });
      res.json(out);
    })
  );

  app.get(
    '/api/admin/empresas.csv',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;
      const db = getDb();
      await ensureAdminColumns(db);
      const rows = await db.all(`SELECT * FROM empresas ORDER BY criado_em DESC LIMIT 2000`);
      let tokensByEmp: any[] = [];
      try {
        tokensByEmp = await db.all(
          `SELECT empresa_id, SUM(tokens) as total_tokens FROM ai_usage GROUP BY empresa_id`
        );
      } catch {
        tokensByEmp = [];
      }
      const tokMap = new Map(
        (tokensByEmp || []).map((t: any) => [t.empresa_id, Number(t.total_tokens || 0)])
      );

      const header = [
        'id',
        'nome_empresa',
        'cnpj',
        'slug',
        'status',
        'plan',
        'billing_cycle',
        'criado_em',
        'expira_em',
        'total_tokens',
        'google_review_url',
        'whatsapp_suporte',
      ];
      const lines = [header.join(',')];
      for (const e of rows || []) {
        lines.push(
          [
            e.id,
            e.nome_empresa,
            e.cnpj,
            e.slug,
            e.status,
            e.plan,
            e.billing_cycle || 'month',
            e.criado_em,
            e.expira_em,
            tokMap.get(e.id) || 0,
            e.google_review_url,
            e.whatsapp_suporte,
          ]
            .map(csvEscape)
            .join(',')
        );
      }
      const body = '\uFEFF' + lines.join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="empresas-filtra.csv"');
      res.send(body);
    })
  );

  app.get(
    '/api/admin/stripe/invoices',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!requireAdmin(req, res)) return;
      const result = await listStripeInvoices(40);
      res.json(result);
    })
  );

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

      const { dias, ciclo } = parseCicloDias(req.body || {});

      let plan = String(emp.plan || 'inicial').toLowerCase();
      if (req.body?.plan) {
        plan = String(req.body.plan).toLowerCase();
      }

      const status = plan === 'trial' || plan === 'teste' ? 'trial' : 'ativo';

      const expAtual = emp.expira_em ? new Date(emp.expira_em).getTime() : 0;
      const baseMs = Number.isFinite(expAtual) && expAtual > Date.now() ? expAtual : Date.now();
      const novaExp = new Date(baseMs + dias * 24 * 60 * 60 * 1000);
      const expiraIso = novaExp.toISOString();

      await db.run(
        `UPDATE empresas SET
          status = ?,
          plan = ?,
          billing_cycle = ?,
          expira_em = ?,
          cancel_at_period_end = 0
         WHERE id = ?`,
        [status, plan, ciclo, expiraIso, id]
      );

      const confirm = await db.get(
        `SELECT id, status, plan, expira_em, billing_cycle FROM empresas WHERE id = ?`,
        [id]
      );

      if (!confirm?.expira_em) {
        return res.status(500).json({
          error: 'Falha ao gravar nova data de vencimento. Tente de novo.',
        });
      }

      const label = ciclo === 'year' ? '1 ano' : '1 mês';
      res.json({
        success: true,
        plan: confirm.plan,
        status: confirm.status,
        expira_em: confirm.expira_em,
        dias_adicionados: dias,
        ciclo,
        mensagem: `Acesso estendido em ${label} (+${dias} dias). Novo vencimento: ${new Date(
          confirm.expira_em
        ).toLocaleDateString('pt-BR')}.`,
      });
    })
  );

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
          n8n_ok = r.ok || r.status === 404 || r.status === 405;
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
              ? 'Sem chave global; há links Google nas empresas'
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
         ORDER BY r.id DESC LIMIT 100`
      );
      res.json(rows);
    })
  );
}
