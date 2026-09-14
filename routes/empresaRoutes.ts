import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb, findEmpresa } from '../lib/db.js';
import { normalizarWhatsapp, linkWhatsapp } from '../lib/whatsapp.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ensureReviewFraudColumns } from '../lib/reviewFraud.js';
import {
  planTemRelatorio,
  allowPlanSwitch,
  PLANOS_OFICIAIS,
  planLabel,
  isTrialPlan,
  isPlanoOficial,
} from '../lib/plans.js';
import {
  planTemIA,
  getFeedbackLimit,
  getTokenLimit,
  tokensUsadosMes,
  contarReviewsMes,
} from '../lib/quota.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { ensureReviewTreatmentColumns } from '../lib/lgpd.js';

const APP_URL = process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000';

const whatsappPatchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas alterações de WhatsApp. Aguarde.' },
});

const planPatchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: { error: 'Muitas trocas de plano. Aguarde.' },
});

function nivelDashboard(plan: string): 'basico' | 'pro' | 'ultra' | 'executivo' {
  const p = String(plan || 'trial').toLowerCase();
  if (isTrialPlan(p)) return 'executivo';
  if (p === 'rei' || p === 'corporativo') return 'executivo';
  if (p === 'ultra') return 'ultra';
  if (p === 'pro') return 'pro';
  return 'basico';
}

function serieUltimosDias(
  reviews: { rating: number; createdAt: string }[],
  dias = 14
): { dia: string; total: number; positivas: number; negativas: number; media: number }[] {
  const map = new Map<string, { total: number; pos: number; neg: number; soma: number }>();
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  for (let i = dias - 1; i >= 0; i--) {
    const d = new Date(hoje);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    map.set(key, { total: 0, pos: 0, neg: 0, soma: 0 });
  }
  for (const r of reviews) {
    const key = String(r.createdAt || '').slice(0, 10);
    const bucket = map.get(key);
    if (!bucket) continue;
    const rating = Number(r.rating) || 0;
    bucket.total += 1;
    bucket.soma += rating;
    if (rating >= 4) bucket.pos += 1;
    if (rating <= 3) bucket.neg += 1;
  }
  return [...map.entries()].map(([dia, b]) => ({
    dia,
    total: b.total,
    positivas: b.pos,
    negativas: b.neg,
    media: b.total ? Math.round((b.soma / b.total) * 10) / 10 : 0,
  }));
}

function podeGerirEmpresa(req: AuthRequest, empresaId: string): boolean {
  if (isAdminUser(req.user)) return true;
  return Boolean(req.user?.empresa_id && req.user.empresa_id === empresaId);
}

async function ensureReviewSentimentColumns(db: any): Promise<void> {
  for (const sql of [
    `ALTER TABLE reviews ADD COLUMN sentiment TEXT`,
    `ALTER TABLE reviews ADD COLUMN sentiment_score DOUBLE PRECISION`,
    `ALTER TABLE reviews ADD COLUMN sentiment_source TEXT`,
  ]) {
    try {
      await db.exec(sql);
    } catch {
      /* */
    }
  }
}

async function loadReviewsForPainel(db: any, empresaId: string): Promise<any[]> {
  const queries = [
    `SELECT id, name, rating, comment, ai_reply, ai_tags, "createdAt" AS "createdAt",
            COALESCE(is_test, 0) AS is_test, fraud_flags, origin,
            sentiment, sentiment_score, sentiment_source,
            client_whatsapp, treated_at, treated_note
     FROM reviews WHERE empresa_id = ? ORDER BY "createdAt" DESC LIMIT 500`,
    `SELECT id, name, rating, comment, ai_reply, ai_tags, "createdAt" AS "createdAt",
            client_whatsapp, treated_at, treated_note
     FROM reviews WHERE empresa_id = ? ORDER BY "createdAt" DESC LIMIT 500`,
    `SELECT id, name, rating, comment, ai_reply, ai_tags, "createdAt" AS "createdAt"
     FROM reviews WHERE empresa_id = ? ORDER BY "createdAt" DESC LIMIT 500`,
    `SELECT id, name, rating, comment, ai_reply, ai_tags
     FROM reviews WHERE empresa_id = ? LIMIT 500`,
  ];

  for (const sql of queries) {
    try {
      const rows = await db.all(sql, [empresaId]);
      return rows || [];
    } catch (e: any) {
      console.warn('[painel] reviews fallback:', e?.message || e);
    }
  }
  return [];
}

function buildPainelPayload(empresa: any, rows: any[]) {
  const reviews = (rows || []).map((r: any) => {
    let tags: string[] = [];
    if (r.ai_tags) {
      try {
        const parsed = JSON.parse(r.ai_tags);
        if (Array.isArray(parsed)) tags = parsed.map(String);
      } catch {
        tags = [];
      }
    }
    const clientWpp =
      r.client_whatsapp === '[anonimizado]'
        ? null
        : normalizarWhatsapp(r.client_whatsapp);
    return {
      id: r.id,
      name: r.name,
      rating: r.rating,
      comment: r.comment,
      ai_reply: r.ai_reply,
      ai_tags: tags,
      createdAt: r.createdAt || r.created_at || null,
      is_test: Number(r.is_test) === 1,
      fraud_flags: r.fraud_flags || null,
      origin: r.origin || 'publico',
      sentiment: r.sentiment || null,
      sentiment_score: r.sentiment_score != null ? Number(r.sentiment_score) : null,
      sentiment_source: r.sentiment_source || null,
      client_whatsapp: clientWpp,
      client_whatsapp_url: linkWhatsapp(clientWpp),
      client_whatsapp_anon: r.client_whatsapp === '[anonimizado]',
      treated_at: r.treated_at || null,
      treated_note: r.treated_note || null,
      treated: Boolean(r.treated_at),
    };
  });

  const reais = reviews.filter((r) => !r.is_test);
  const total = reais.length;
  const soma = reais.reduce((s: number, r: any) => s + Number(r.rating || 0), 0);
  const media = total ? Math.round((soma / total) * 10) / 10 : 0;
  const negativas = reais.filter((r: any) => r.rating <= 3).length;
  const positivas = reais.filter((r: any) => r.rating >= 4).length;
  const tratadas = reais.filter((r: any) => r.treated && r.rating <= 3).length;

  const dist = [0, 0, 0, 0, 0];
  for (const r of reais) {
    const n = Number(r.rating);
    if (n >= 1 && n <= 5) dist[n - 1] += 1;
  }

  const sentimento_mix = { positivo: 0, neutro: 0, negativo: 0 };
  let scoreSum = 0;
  let scoreN = 0;
  for (const r of reais) {
    const lab = String(r.sentiment || '').toLowerCase();
    if (lab === 'positivo') sentimento_mix.positivo += 1;
    else if (lab === 'negativo') sentimento_mix.negativo += 1;
    else if (lab === 'neutro') sentimento_mix.neutro += 1;
    else {
      if (r.rating >= 4) sentimento_mix.positivo += 1;
      else if (r.rating <= 2) sentimento_mix.negativo += 1;
      else sentimento_mix.neutro += 1;
    }
    if (r.sentiment_score != null && Number.isFinite(r.sentiment_score)) {
      scoreSum += Number(r.sentiment_score);
      scoreN += 1;
    }
  }

  const ha24h = Date.now() - 24 * 60 * 60 * 1000;
  const crises_24h = reais.filter((r: any) => {
    try {
      return r.rating <= 2 && r.createdAt && new Date(r.createdAt).getTime() >= ha24h;
    } catch {
      return false;
    }
  }).length;

  const tagCount: Record<string, number> = {};
  for (const r of reais) {
    for (const t of r.ai_tags || []) {
      const k = String(t);
      tagCount[k] = (tagCount[k] || 0) + 1;
    }
  }
  const top_tags = Object.entries(tagCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag, count]) => ({ tag, count }));

  const serie_14d = serieUltimosDias(reais as any, 14);

  const plan = String(empresa.plan || 'trial').toLowerCase();
  const trial = isTrialPlan(plan);
  const nivel = nivelDashboard(plan);
  const relatorio_disponivel = planTemRelatorio(plan);
  const tem_ia = trial || planTemIA(plan);

  const feedback_limite = getFeedbackLimit(plan);
  const token_limite = getTokenLimit(plan);

  const base = String(APP_URL || 'https://filtraai.com').replace(/\/$/, '');
  const ref = empresa.slug || empresa.id;
  const wpp = normalizarWhatsapp(empresa.whatsapp_suporte);

  const statusAcesso =
    empresa.status === 'bloqueado'
      ? 'BLOQUEADO'
      : trial
        ? 'TRIAL'
        : empresa.status === 'ativo'
          ? 'ATIVO'
          : String(empresa.status || '—').toUpperCase();

  return {
    empresa: {
      id: empresa.id,
      slug: empresa.slug,
      nome_empresa: empresa.nome_empresa,
      status: empresa.status,
      status_acesso: statusAcesso,
      plan: empresa.plan,
      expira_em: empresa.expira_em,
      cancel_at_period_end: Number(empresa.cancel_at_period_end) === 1,
      google_review_url: empresa.google_review_url || null,
      whatsapp: wpp,
      whatsapp_url: linkWhatsapp(wpp),
      locale: empresa.locale || 'pt',
    },
    reviews: reviews.slice(0, 200),
    metricas: {
      total,
      media,
      negativas,
      positivas,
      tratadas,
      pendentes_tratamento: Math.max(0, negativas - tratadas),
      alerta_crise: crises_24h >= 3,
      crises_24h,
      distribuicao: dist,
      top_tags: tem_ia ? top_tags : [],
      taxa_positiva: total ? Math.round((positivas / total) * 100) : 0,
      serie_14d,
      testes_excluidos: reviews.filter((r) => r.is_test).length,
      sentimento_mix,
      sentimento_score_medio:
        scoreN > 0 ? Math.round((scoreSum / scoreN) * 100) / 100 : null,
      feedback_usados: total,
      feedback_limite,
      tokens_usados: 0,
      tokens_limite: token_limite,
      tokens_pct: 0,
    },
    dashboard: {
      nivel,
      relatorio_disponivel,
      pdf_disponivel: relatorio_disponivel,
      tem_ia,
      trial_completo: trial,
      plan_switch: allowPlanSwitch(),
      planos_teste: allowPlanSwitch()
        ? PLANOS_OFICIAIS.map((p) => ({ key: p, label: planLabel(p) }))
        : [],
      mostrar_graficos: true,
      mostrar_tendencia:
        trial || nivel === 'pro' || nivel === 'ultra' || nivel === 'executivo',
      mostrar_tags: tem_ia && (trial || nivel === 'ultra' || nivel === 'executivo'),
      mostrar_crise: true,
      mostrar_sentimento: true,
      mostrar_ia_respostas: tem_ia,
      mostrar_whatsapp_cliente: true,
      mostrar_copiar_resposta: true,
      mostrar_tratar: true,
      whatsapp_crise: true,
    },
    integracoes: {
      push: Boolean(
        process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim()
      ),
      n8n: Boolean(process.env.N8N_WEBHOOK_URL?.trim()),
      stripe: Boolean(process.env.STRIPE_SECRET_KEY?.trim()),
      smtp: Boolean(process.env.SMTP_HOST?.trim() && process.env.SMTP_FROM?.trim()),
      google_review: Boolean(empresa.google_review_url),
    },
    links: {
      avaliacao: `${base}/avaliacao/${ref}`,
      painel: `${base}/painel/${ref}`,
      widget: `${base}/widget/${ref}`,
      embed: `${base}/avaliacao/${ref}`,
      relatorio_enviar: relatorio_disponivel
        ? `/api/empresa/${ref}/relatorio/enviar`
        : null,
      login: `${base}/login`,
    },
  };
}

export function mountEmpresaRoutes(app: Express) {
  app.get(
    '/api/empresa/:ref/validar',
    asyncHandler(async (req: Request, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ valido: false, motivo: 'not_found' });
      const agora = new Date();
      const expira = new Date(empresa.expira_em);
      if ((empresa.status === 'trial' || empresa.status === 'teste') && agora > expira) {
        return res.json({
          valido: false,
          motivo: 'expired',
          nome: empresa.nome_empresa,
          empresa_id: empresa.id,
          slug: empresa.slug,
        });
      }
      if (empresa.status === 'bloqueado') {
        return res.json({ valido: false, motivo: 'inactive', nome: empresa.nome_empresa });
      }
      const wpp = normalizarWhatsapp(empresa.whatsapp_suporte);
      return res.json({
        valido: true,
        nome: empresa.nome_empresa,
        empresa_id: empresa.id,
        slug: empresa.slug,
        google_review_url: empresa.google_review_url || null,
        whatsapp: wpp,
        whatsapp_url: linkWhatsapp(wpp),
        plan: empresa.plan,
      });
    })
  );

  app.patch(
    '/api/empresa/:ref/plano',
    planPatchLimiter,
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!allowPlanSwitch()) {
        return res.status(403).json({
          error:
            'Troca de plano de teste desativada em produção. Use checkout ou defina ALLOW_PLAN_SWITCH=1.',
          code: 'PLAN_SWITCH_DISABLED',
        });
      }

      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerirEmpresa(req, empresa.id)) {
        return res.status(403).json({ error: 'Sem permissão. Faça login com a conta desta empresa.' });
      }

      const plan = String(req.body.plan || req.body.plano || '')
        .toLowerCase()
        .trim();
      if (!isPlanoOficial(plan) && !isTrialPlan(plan)) {
        return res.status(400).json({
          error: `Plano inválido. Use: ${[...PLANOS_OFICIAIS, 'trial'].join(', ')}`,
        });
      }

      const dias = isTrialPlan(plan) ? 7 : 30;
      const expira = new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toISOString();
      const status = isTrialPlan(plan) ? 'trial' : 'ativo';

      await getDb().run(
        `UPDATE empresas SET plan = ?, status = ?, expira_em = ?, cancel_at_period_end = 0 WHERE id = ?`,
        [plan, status, expira, empresa.id]
      );

      const relatorio_ok = planTemRelatorio(plan);
      res.json({
        success: true,
        plan,
        status,
        expira_em: expira,
        mensagem: `Plano ${planLabel(plan)} ativo (modo teste — sem cobrança).`,
        relatorio_disponivel: relatorio_ok,
        pdf_disponivel: relatorio_ok,
      });
    })
  );

  app.patch(
    '/api/empresa/:ref/whatsapp',
    whatsappPatchLimiter,
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerirEmpresa(req, empresa.id)) {
        return res.status(403).json({ error: 'Sem permissão para alterar o WhatsApp desta empresa.' });
      }
      const raw = String(req.body.whatsapp || req.body.whatsapp_suporte || '').trim();
      if (!raw) {
        await getDb().run(`UPDATE empresas SET whatsapp_suporte = NULL WHERE id = ?`, [empresa.id]);
        return res.json({ success: true, whatsapp: null, whatsapp_url: null });
      }
      const normalizado = normalizarWhatsapp(raw);
      if (!normalizado) {
        return res.status(400).json({
          error: 'WhatsApp inválido. Use DDD + número (ex: 11999998888 ou +55 11 99999-8888).',
        });
      }
      await getDb().run(`UPDATE empresas SET whatsapp_suporte = ? WHERE id = ?`, [
        normalizado,
        empresa.id,
      ]);
      res.json({
        success: true,
        whatsapp: normalizado,
        whatsapp_url: linkWhatsapp(normalizado),
      });
    })
  );

  app.patch(
    '/api/empresa/:ref/google',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerirEmpresa(req, empresa.id)) {
        return res.status(403).json({ error: 'Sem permissão.' });
      }
      let url = String(req.body.google_review_url || req.body.url || '').trim();
      if (!url) {
        await getDb().run(`UPDATE empresas SET google_review_url = NULL WHERE id = ?`, [empresa.id]);
        return res.json({ success: true, google_review_url: null });
      }
      if (!/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: 'URL inválida. Use http:// ou https://' });
      }
      if (url.length > 500) {
        return res.status(400).json({ error: 'URL muito longa (máx. 500).' });
      }
      await getDb().run(`UPDATE empresas SET google_review_url = ? WHERE id = ?`, [url, empresa.id]);
      res.json({ success: true, google_review_url: url });
    })
  );

  app.get(
    '/api/empresa/:ref/painel',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) {
        return res.status(404).json({ error: 'Empresa não encontrada.' });
      }
      if (!podeGerirEmpresa(req, empresa.id)) {
        return res.status(403).json({
          error: 'Sem permissão. Faça login com a conta desta empresa.',
          code: 'FORBIDDEN_PAINEL',
        });
      }

      try {
        const db = getDb();
        try {
          await ensureReviewFraudColumns(db);
        } catch (e: any) {
          console.warn('[painel] fraud cols:', e?.message || e);
        }
        try {
          await ensureReviewTreatmentColumns(db);
        } catch (e: any) {
          console.warn('[painel] treatment cols:', e?.message || e);
        }
        try {
          await ensureReviewSentimentColumns(db);
        } catch (e: any) {
          console.warn('[painel] sentiment cols:', e?.message || e);
        }

        const rows = await loadReviewsForPainel(db, empresa.id);
        const payload = buildPainelPayload(empresa, rows);

        // Enriquecer quotas sem quebrar
        try {
          payload.metricas.feedback_usados = await contarReviewsMes(empresa.id);
        } catch {
          /* keep total */
        }
        try {
          if (payload.dashboard.tem_ia) {
            payload.metricas.tokens_usados = await tokensUsadosMes(empresa.id);
            const lim = payload.metricas.tokens_limite;
            payload.metricas.tokens_pct =
              lim > 0
                ? Math.min(100, Math.round((payload.metricas.tokens_usados / lim) * 100))
                : 0;
          }
        } catch {
          /* */
        }

        return res.json(payload);
      } catch (e: any) {
        console.error('[painel] FATAL fallback:', e?.message || e, e?.code);
        // Nunca 500 no painel pós-trial: devolve esqueleto utilizável
        try {
          return res.json(buildPainelPayload(empresa, []));
        } catch (e2: any) {
          console.error('[painel] skeleton fail:', e2?.message || e2);
          const base = String(APP_URL || 'https://filtraai.com').replace(/\/$/, '');
          const ref = empresa.slug || empresa.id;
          return res.json({
            empresa: {
              id: empresa.id,
              slug: empresa.slug,
              nome_empresa: empresa.nome_empresa,
              status: empresa.status,
              status_acesso: 'TRIAL',
              plan: empresa.plan || 'trial',
              expira_em: empresa.expira_em,
              cancel_at_period_end: false,
              google_review_url: null,
              whatsapp: null,
              whatsapp_url: null,
              locale: 'pt',
            },
            reviews: [],
            metricas: {
              total: 0,
              media: 0,
              negativas: 0,
              positivas: 0,
              tratadas: 0,
              pendentes_tratamento: 0,
              alerta_crise: false,
              crises_24h: 0,
              distribuicao: [0, 0, 0, 0, 0],
              top_tags: [],
              taxa_positiva: 0,
              serie_14d: [],
              testes_excluidos: 0,
              sentimento_mix: { positivo: 0, neutro: 0, negativo: 0 },
              sentimento_score_medio: null,
              feedback_usados: 0,
              feedback_limite: 30,
              tokens_usados: 0,
              tokens_limite: 25000,
              tokens_pct: 0,
            },
            dashboard: {
              nivel: 'executivo',
              relatorio_disponivel: true,
              pdf_disponivel: true,
              tem_ia: true,
              trial_completo: true,
              plan_switch: false,
              planos_teste: [],
              mostrar_graficos: true,
              mostrar_tendencia: true,
              mostrar_tags: true,
              mostrar_crise: true,
              mostrar_sentimento: true,
              mostrar_ia_respostas: true,
              mostrar_whatsapp_cliente: true,
              mostrar_copiar_resposta: true,
              mostrar_tratar: true,
              whatsapp_crise: true,
            },
            integracoes: {
              push: false,
              n8n: false,
              stripe: false,
              smtp: false,
              google_review: false,
            },
            links: {
              avaliacao: `${base}/avaliacao/${ref}`,
              painel: `${base}/painel/${ref}`,
              widget: `${base}/widget/${ref}`,
              embed: `${base}/avaliacao/${ref}`,
              relatorio_enviar: `/api/empresa/${ref}/relatorio/enviar`,
              login: `${base}/login`,
            },
            _degraded: true,
          });
        }
      }
    })
  );
}
