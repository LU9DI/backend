import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb, findEmpresa } from '../lib/db.js';
import { normalizarWhatsapp, linkWhatsapp } from '../lib/whatsapp.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  allowPlanSwitch,
  PLANOS_OFICIAIS,
  planLabel,
  isTrialPlan,
  isPlanoOficial,
  planTemPdf,
} from '../lib/plans.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';

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

function podeGerirEmpresa(req: AuthRequest, empresaId: string): boolean {
  if (isAdminUser(req.user)) return true;
  const uid = String(req.user?.empresa_id || '');
  return Boolean(uid && uid === empresaId);
}

/** Série diária dos últimos 14 dias (UTC) a partir das reviews. */
function serieUltimos14d(reviews: { createdAt?: string; rating?: number; is_test?: boolean }[]) {
  const map = new Map<string, { total: number; soma: number }>();
  const hoje = new Date();
  hoje.setUTCHours(0, 0, 0, 0);
  for (let i = 13; i >= 0; i--) {
    const d = new Date(hoje);
    d.setUTCDate(hoje.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    map.set(key, { total: 0, soma: 0 });
  }
  for (const r of reviews) {
    if (r.is_test) continue;
    const raw = r.createdAt;
    if (!raw) continue;
    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) continue;
    const key = dt.toISOString().slice(0, 10);
    const bucket = map.get(key);
    if (!bucket) continue;
    bucket.total += 1;
    bucket.soma += Number(r.rating) || 0;
  }
  return Array.from(map.entries()).map(([data, v]) => ({
    data,
    total: v.total,
    media: v.total ? Math.round((v.soma / v.total) * 10) / 10 : 0,
  }));
}

export function mountEmpresaRoutes(app: Express) {
  app.get(
    '/api/empresa/:ref/validar',
    asyncHandler(async (req: Request, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ valido: false, motivo: 'not_found' });
      const wpp = normalizarWhatsapp(empresa.whatsapp_suporte);
      return res.json({
        valido: true,
        nome: empresa.nome_empresa,
        empresa_id: empresa.id,
        slug: empresa.slug,
        plan: empresa.plan,
        google_review_url: empresa.google_review_url || null,
        whatsapp: wpp,
        whatsapp_url: linkWhatsapp(wpp),
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
        return res.status(403).json({ error: 'Sem permissão. Faça login com a conta desta empresa.' });
      }
      const raw = String(req.body.whatsapp || req.body.whatsapp_suporte || '').trim();
      if (!raw) {
        await getDb().run(`UPDATE empresas SET whatsapp_suporte = NULL WHERE id = ?`, [empresa.id]);
        return res.json({ success: true, whatsapp: null, whatsapp_url: null });
      }
      const normalizado = normalizarWhatsapp(raw);
      if (!normalizado) {
        return res.status(400).json({
          error: 'WhatsApp inválido. Use DDD + número (ex: 11 99999-8888).',
        });
      }
      await getDb().run(`UPDATE empresas SET whatsapp_suporte = ? WHERE id = ?`, [
        normalizado,
        empresa.id,
      ]);
      return res.json({
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
        return res.status(403).json({ error: 'Sem permissão. Faça login com a conta desta empresa.' });
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
      return res.json({ success: true, google_review_url: url });
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
            'Troca de plano de teste desativada em produção. Use checkout ou ALLOW_PLAN_SWITCH=1.',
          code: 'PLAN_SWITCH_DISABLED',
        });
      }
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerirEmpresa(req, empresa.id)) {
        return res.status(403).json({ error: 'Sem permissão.' });
      }
      const plan = String(req.body.plan || req.body.plano || '').toLowerCase().trim();
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
      return res.json({
        success: true,
        plan,
        status,
        expira_em: expira,
        mensagem: `Plano ${planLabel(plan)} ativo.`,
        pdf_disponivel: planTemPdf(plan),
      });
    })
  );

  app.get(
    '/api/empresa/:ref/painel',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerirEmpresa(req, empresa.id)) {
        return res.status(403).json({
          error: 'Sem permissão. Faça login com a conta desta empresa.',
          code: 'FORBIDDEN_PAINEL',
        });
      }

      const wpp = normalizarWhatsapp(empresa.whatsapp_suporte);
      const plan = String(empresa.plan || 'trial').toLowerCase();
      const trial = isTrialPlan(plan);

      let reviews: any[] = [];
      try {
        const rows = await getDb().all(
          `SELECT * FROM reviews WHERE empresa_id = ? ORDER BY id DESC LIMIT 500`,
          [empresa.id]
        );
        reviews = (rows || []).map((r: any) => {
          const clientWpp = normalizarWhatsapp(r.client_whatsapp);
          return {
            id: r.id,
            name: r.name,
            rating: r.rating,
            comment: r.comment,
            ai_reply: r.ai_reply,
            ai_tags: (() => {
              try {
                const p = JSON.parse(r.ai_tags || '[]');
                return Array.isArray(p) ? p : [];
              } catch {
                return [];
              }
            })(),
            createdAt: r.createdAt || r.createdat || r.created_at,
            is_test: Number(r.is_test) === 1,
            treated: Boolean(r.treated_at),
            client_whatsapp: clientWpp,
            client_whatsapp_url: linkWhatsapp(clientWpp),
            client_whatsapp_anon: Boolean(r.client_whatsapp && !clientWpp),
          };
        });
      } catch (e: any) {
        console.warn('[painel] reviews:', e?.message || e);
      }

      const reais = reviews.filter((r) => !r.is_test);
      const total = reais.length;
      const soma = reais.reduce((s: number, r: any) => s + Number(r.rating || 0), 0);
      const media = total ? Math.round((soma / total) * 10) / 10 : 0;
      const negativas = reais.filter((r: any) => r.rating <= 3).length;
      const positivas = reais.filter((r: any) => r.rating >= 4).length;
      const dist = [0, 0, 0, 0, 0];
      for (const r of reais) {
        const n = Number(r.rating);
        if (n >= 1 && n <= 5) dist[n - 1] += 1;
      }

      const serie_14d = serieUltimos14d(reais);

      const APP_URL = process.env.APP_URL || process.env.FRONTEND_URL || 'https://filtraai.com';
      const base = String(APP_URL).replace(/\/$/, '');
      const ref = empresa.slug || empresa.id;

      return res.json({
        empresa: {
          id: empresa.id,
          slug: empresa.slug,
          nome_empresa: empresa.nome_empresa,
          status: empresa.status,
          status_acesso: trial ? 'TRIAL' : String(empresa.status || '—').toUpperCase(),
          plan: empresa.plan || 'trial',
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
          tratadas: reais.filter((r: any) => r.treated).length,
          pendentes_tratamento: Math.max(
            0,
            negativas - reais.filter((r: any) => r.treated && r.rating <= 3).length
          ),
          alerta_crise: false,
          crises_24h: 0,
          distribuicao: dist,
          top_tags: [],
          taxa_positiva: total ? Math.round((positivas / total) * 100) : 0,
          serie_14d,
          testes_excluidos: reviews.filter((r) => r.is_test).length,
          sentimento_mix: { positivo: 0, neutro: 0, negativo: 0 },
          feedback_usados: total,
          feedback_limite: 50,
          tokens_usados: 0,
          tokens_limite: 0,
          tokens_pct: 0,
        },
        dashboard: {
          nivel:
            trial || plan === 'ultra' || plan === 'rei' || plan === 'corporativo'
              ? 'executivo'
              : plan === 'pro'
                ? 'pro'
                : 'basico',
          pdf_disponivel: planTemPdf(plan) || trial,
          tem_ia: trial || ['ultra', 'corporativo', 'rei', 'pro'].includes(plan),
          trial_completo: trial,
          plan_switch: false,
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
        integracoes: {},
        links: {
          avaliacao: `${base}/avaliacao/${ref}`,
          painel: `${base}/painel/${ref}`,
          widget: `${base}/widget/${ref}`,
          login: `${base}/login`,
        },
      });
    })
  );
}
