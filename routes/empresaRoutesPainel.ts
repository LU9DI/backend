import type { Express, Response } from 'express';
import { getDb, findEmpresa } from '../lib/db.js';
import { normalizarWhatsapp, linkWhatsapp } from '../lib/whatsapp.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ensureReviewFraudColumns } from '../lib/reviewFraud.js';
import {
  planTemPdf,
  allowPlanSwitch,
  PLANOS_OFICIAIS,
  planLabel,
  isTrialPlan,
} from '../lib/plans.js';
import {
  planTemIA,
  getFeedbackLimit,
  getTokenLimit,
  tokensUsadosMes,
  contarReviewsMes,
} from '../lib/quota.js';
import { autenticarToken, type AuthRequest } from '../lib/auth.js';
import { ensureReviewTreatmentColumns } from '../lib/lgpd.js';
import {
  APP_URL,
  nivelDashboard,
  normalizeReviewDate,
  serieUltimosDias,
  podeGerirEmpresa,
  emptyPainel,
  loadReviewsSafe,
} from './empresaRoutesHelpers.js';

export function mountEmpresaPainelRoute(app: Express) {
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
        for (const ddl of [
          'sentiment TEXT',
          'sentiment_score DOUBLE PRECISION',
          'sentiment_source TEXT',
        ]) {
          try {
            await db.exec(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS ${ddl}`);
          } catch {
            try {
              await db.exec(`ALTER TABLE reviews ADD COLUMN ${ddl}`);
            } catch {
              /* ok */
            }
          }
        }

        const rows = await loadReviewsSafe(db, empresa.id);
        let recentRows: any[] = [];
        try {
          const since14d = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString();
          recentRows = await db.all(
            `SELECT rating, "createdAt", is_test
             FROM reviews
             WHERE empresa_id = ? AND "createdAt" >= ?
             ORDER BY "createdAt" ASC
             LIMIT 10000`,
            [empresa.id, since14d]
          );
        } catch (e: any) {
          console.warn('[painel] reviews 14d:', e?.message || e);
          recentRows = [];
        }

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
          const createdAt = normalizeReviewDate(
            r.createdAt ?? r.createdat ?? r.created_at
          );
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
            createdAt,
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
          else if (r.rating >= 4) sentimento_mix.positivo += 1;
          else if (r.rating <= 2) sentimento_mix.negativo += 1;
          else sentimento_mix.neutro += 1;
          if (r.sentiment_score != null && Number.isFinite(r.sentiment_score)) {
            scoreSum += Number(r.sentiment_score);
            scoreN += 1;
          }
        }

        const ha24h = Date.now() - 24 * 60 * 60 * 1000;
        const crises_24h = reais.filter((r: any) => {
          try {
            return r.rating <= 2 && new Date(r.createdAt).getTime() >= ha24h;
          } catch {
            return false;
          }
        }).length;

        const tagCount: Record<string, number> = {};
        for (const r of reais) {
          for (const t of r.ai_tags || []) {
            tagCount[String(t)] = (tagCount[String(t)] || 0) + 1;
          }
        }
        const top_tags = Object.entries(tagCount)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([tag, count]) => ({ tag, count }));

        const plan = String(empresa.plan || 'trial').toLowerCase();
        const trial = isTrialPlan(plan);
        const nivel = nivelDashboard(plan);
        const pdf_disponivel = planTemPdf(plan);
        const tem_ia = trial || planTemIA(plan);

        let feedback_usados = total;
        let token_usados = 0;
        try {
          feedback_usados = await contarReviewsMes(empresa.id);
        } catch {
          feedback_usados = total;
        }
        try {
          token_usados = tem_ia ? await tokensUsadosMes(empresa.id) : 0;
        } catch {
          token_usados = 0;
        }

        const feedback_limite = getFeedbackLimit(plan);
        const token_limite = getTokenLimit(plan);
        const base = String(APP_URL || 'https://filtraai.com').replace(/\/$/, '');
        const ref = empresa.slug || empresa.id;
        const wpp = normalizarWhatsapp(empresa.whatsapp_suporte);

        return res.json({
          empresa: {
            id: empresa.id,
            slug: empresa.slug,
            nome_empresa: empresa.nome_empresa,
            status: empresa.status,
            status_acesso: trial
              ? 'TRIAL'
              : empresa.status === 'bloqueado'
                ? 'BLOQUEADO'
                : empresa.status === 'ativo'
                  ? 'ATIVO'
                  : String(empresa.status || '—').toUpperCase(),
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
            serie_14d: (() => {
              const fromRecent = (recentRows || [])
                .filter((r: any) => Number(r.is_test) !== 1)
                .map((r: any) => ({
                  rating: Number(r.rating) || 0,
                  createdAt: normalizeReviewDate(r.createdAt ?? r.createdat ?? r.created_at),
                }));
              const fromLoaded =
                fromRecent.length > 0
                  ? fromRecent
                  : reais.map((r: any) => ({
                      rating: Number(r.rating) || 0,
                      createdAt: String(r.createdAt || ''),
                    }));
              return serieUltimosDias(fromLoaded, 14);
            })(),
            testes_excluidos: reviews.filter((r) => r.is_test).length,
            sentimento_mix,
            sentimento_score_medio:
              scoreN > 0 ? Math.round((scoreSum / scoreN) * 100) / 100 : null,
            feedback_usados,
            feedback_limite,
            tokens_usados: token_usados,
            tokens_limite: token_limite,
            tokens_pct:
              token_limite > 0
                ? Math.min(100, Math.round((token_usados / token_limite) * 100))
                : 0,
          },
          dashboard: {
            nivel,
            pdf_disponivel,
            tem_ia,
            trial_completo: trial,
            plan_switch: allowPlanSwitch(),
            planos_teste: allowPlanSwitch()
              ? PLANOS_OFICIAIS.map((p) => ({ key: p, label: planLabel(p) }))
              : [],
            mostrar_graficos: true,
            mostrar_tendencia: true,
            mostrar_tags: tem_ia,
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
            relatorio_pdf: pdf_disponivel ? `/api/empresa/${ref}/relatorio.pdf` : null,
            login: `${base}/login`,
          },
        });
      } catch (e: any) {
        console.error('[painel] FALLBACK:', e?.message || e);
        return res.json(emptyPainel(empresa));
      }
    })
  );
}
