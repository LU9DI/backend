import type { AuthRequest } from '../lib/auth.js';
import { isAdminUser } from '../lib/auth.js';
import { normalizarWhatsapp, linkWhatsapp } from '../lib/whatsapp.js';
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
} from '../lib/quota.js';

export const APP_URL = process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000';

export function nivelDashboard(plan: string): 'basico' | 'pro' | 'ultra' | 'executivo' {
  const p = String(plan || 'trial').toLowerCase();
  if (isTrialPlan(p)) return 'executivo';
  if (p === 'rei' || p === 'corporativo') return 'executivo';
  if (p === 'ultra') return 'ultra';
  if (p === 'pro') return 'pro';
  return 'basico';
}

export function normalizeReviewDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const text = String(value ?? '').trim();
  if (text) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
    return text;
  }
  return new Date().toISOString();
}

export function serieUltimosDias(
  reviews: { rating: number; createdAt: string }[],
  dias = 14
): { dia: string; data: string; total: number; positivas: number; negativas: number; media: number }[] {
  const map = new Map<string, { total: number; pos: number; neg: number; soma: number }>();
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const day = now.getUTCDate();
  for (let i = dias - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m, day - i));
    map.set(d.toISOString().slice(0, 10), { total: 0, pos: 0, neg: 0, soma: 0 });
  }
  for (const r of reviews) {
    const raw = String(r.createdAt || '').trim();
    let key = raw.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime())) key = parsed.toISOString().slice(0, 10);
      else continue;
    }
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
    data: dia,
    total: b.total,
    positivas: b.pos,
    negativas: b.neg,
    media: b.total ? Math.round((b.soma / b.total) * 10) / 10 : 0,
  }));
}

export function podeGerirEmpresa(req: AuthRequest, empresaId: string): boolean {
  if (isAdminUser(req.user)) return true;
  return Boolean(req.user?.empresa_id && req.user.empresa_id === empresaId);
}

export function emptyPainel(empresa: any) {
  const base = String(APP_URL || 'https://filtraai.com').replace(/\/$/, '');
  const ref = empresa.slug || empresa.id;
  const plan = String(empresa.plan || 'trial').toLowerCase();
  const trial = isTrialPlan(plan);
  const tem_ia = trial || planTemIA(plan);
  const pdf = planTemPdf(plan);
  const wpp = normalizarWhatsapp(empresa.whatsapp_suporte);
  return {
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
      serie_14d: serieUltimosDias([], 14),
      testes_excluidos: 0,
      sentimento_mix: { positivo: 0, neutro: 0, negativo: 0 },
      sentimento_score_medio: null,
      feedback_usados: 0,
      feedback_limite: getFeedbackLimit(plan),
      tokens_usados: 0,
      tokens_limite: getTokenLimit(plan),
      tokens_pct: 0,
    },
    dashboard: {
      nivel: nivelDashboard(plan),
      pdf_disponivel: pdf,
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
      push: Boolean(process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim()),
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
      relatorio_pdf: pdf ? `/api/empresa/${ref}/relatorio.pdf` : null,
      login: `${base}/login`,
    },
  };
}

export async function loadReviewsSafe(db: any, empresaId: string): Promise<any[]> {
  const queries = [
    `SELECT * FROM reviews WHERE empresa_id = ? ORDER BY id DESC LIMIT 500`,
    `SELECT * FROM reviews WHERE empresa_id = ? LIMIT 500`,
  ];
  for (const q of queries) {
    try {
      const rows = await db.all(q, [empresaId]);
      return Array.isArray(rows) ? rows : [];
    } catch (e: any) {
      console.warn('[painel] reviews query:', e?.message || e);
    }
  }
  return [];
}
