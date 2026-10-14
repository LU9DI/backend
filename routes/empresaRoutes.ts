import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb, findEmpresa } from '../lib/db.js';
import {
  normalizarWhatsapp,
  linkWhatsapp,
  mensagemEmpresaParaCliente,
} from '../lib/whatsapp.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ensureReviewFraudColumns } from '../lib/reviewFraud.js';
import {
  planTemPdf,
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
import { ensureUnidadesSchema } from '../lib/unidades.js';

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

function rowCreatedAt(r: any): string {
  return String(r.createdAt || r.createdat || r.created_at || '') || new Date().toISOString();
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

function unidadeRanking(reviews: any[], unidades: any[]) {
  const real = (reviews || []).filter((r) => !r.is_test);
  const now = Date.now();
  const periodStart = now - 14 * 24 * 60 * 60 * 1000;
  const previousStart = now - 28 * 24 * 60 * 60 * 1000;
  const groups = (unidades || []).map((u: any) => {
    const list = real.filter((r) => String(r.unidade_id || '') === String(u.id));
    const current = list.filter((r) => {
      const t = new Date(r.createdAt || r.created_at || r.createdat || 0).getTime();
      return t >= periodStart;
    });
    const previous = list.filter((r) => {
      const t = new Date(r.createdAt || r.created_at || r.createdat || 0).getTime();
      return t >= previousStart && t < periodStart;
    });
    const avg = list.length ? list.reduce((s: number, r: any) => s + Number(r.rating || 0), 0) / list.length : 0;
    const curAvg = current.length ? current.reduce((s: number, r: any) => s + Number(r.rating || 0), 0) / current.length : 0;
    const prevAvg = previous.length ? previous.reduce((s: number, r: any) => s + Number(r.rating || 0), 0) / previous.length : 0;
    const delta = current.length && previous.length ? curAvg - prevAvg : 0;
    const critical = list.filter((r: any) => Number(r.rating) <= 3).length;
    const positive = list.filter((r: any) => Number(r.rating) >= 4).length;
    const positiveRate = list.length ? positive / list.length : 0;
    return {
      id: String(u.id),
      nome: String(u.nome || 'Unidade'),
      cidade: u.cidade || null,
      feedbacks: list.length,
      nota: Math.round(avg * 10) / 10,
      positivas: positive,
      criticas: critical,
      taxa_positiva: Math.round(positiveRate * 100),
      tendencia_14d: Math.round(delta * 10) / 10,
      feedbacks_14d: current.length,
      status: avg >= 4.5 ? 'excelente' : avg >= 4 ? 'boa' : avg >= 3.5 ? 'atencao' : list.length ? 'critica' : 'sem_dados',
    };
  });
  return groups.sort((a: any, b: any) => b.nota - a.nota || b.feedbacks - a.feedbacks);
}

function resumoUnidades(ranking: any[]) {
  const comDados = (ranking || []).filter((u: any) => u.feedbacks > 0);
  const porTendencia = [...comDados].sort((a, b) => Number(b.tendencia_14d || 0) - Number(a.tendencia_14d || 0));
  const melhor = comDados[0] || null;
  const pior = [...comDados].sort((a, b) => Number(a.nota || 0) - Number(b.nota || 0))[0] || null;
  return {
    total_unidades: (ranking || []).length,
    unidades_com_dados: comDados.length,
    melhor_unidade: melhor ? { id: melhor.id, nome: melhor.nome, nota: melhor.nota } : null,
    unidade_atencao: pior ? { id: pior.id, nome: pior.nome, nota: pior.nota } : null,
    maior_evolucao: porTendencia[0] && Number(porTendencia[0].tendencia_14d || 0) > 0
      ? { id: porTendencia[0].id, nome: porTendencia[0].nome, delta: porTendencia[0].tendencia_14d }
      : null,
    maior_queda: porTendencia.length && Number(porTendencia[porTendencia.length - 1].tendencia_14d || 0) < 0
      ? { id: porTendencia[porTendencia.length - 1].id, nome: porTendencia[porTendencia.length - 1].nome, delta: porTendencia[porTendencia.length - 1].tendencia_14d }
      : null,
  };
}


function insightsOperacionaisPorUnidade(reviews: any[], ranking: any[]) {
  const real = (reviews || []).filter((r) => !r.is_test);
  return (ranking || []).map((u: any) => {
    const list = real.filter((r: any) => String(r.unidade_id || '') === String(u.id));
    const positive: Record<string, number> = {};
    const issues: Record<string, number> = {};
    for (const r of list) {
      const target = Number(r.rating) >= 4 ? positive : Number(r.rating) <= 3 ? issues : null;
      if (!target) continue;
      const tags = Array.isArray(r.ai_tags) ? r.ai_tags : [];
      for (const tag of tags) {
        const key = String(tag || '').trim();
        if (key) target[key] = (target[key] || 0) + 1;
      }
    }
    const top = (source: Record<string, number>) => Object.entries(source)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tag, count]) => ({ tag, count }));
    return { id: u.id, nome: u.nome, pontos_fortes: top(positive), pontos_atencao: top(issues) };
  });
}


export function prioridadesOperacionaisPorUnidade(ranking: any[], insights: any[]) {
  const byId = new Map((insights || []).map((u: any) => [String(u.id), u]));
  const actionFor = (tag: string, critical: boolean) => {
    const t = String(tag || '').toLowerCase();
    if (/tempo|espera|demora|atraso/.test(t)) return 'Reduzir tempo de espera e revisar o fluxo operacional.';
    if (/atendimento|equipe|servi|funcion/.test(t)) return 'Revisar atendimento, treinamento e padrão de execução da equipe.';
    if (/preço|preco|valor|custo/.test(t)) return 'Avaliar percepção de valor, preço e ofertas frente à demanda observada.';
    if (/produto|qualidade|estrutura|ambiente/.test(t)) return 'Atacar a causa operacional do tema e acompanhar a evolução da nota.';
    if (/limpeza|higiene/.test(t)) return 'Reforçar rotina, checklist e controle de qualidade deste processo.';
    return critical
      ? 'Criar plano corretivo para o tema e acompanhar a evolução semanal.'
      : 'Testar uma melhoria operacional focada neste tema e medir o impacto.';
  };

  const result: any[] = [];
  for (const u of ranking || []) {
    if (!u.feedbacks) continue;
    const insight = byId.get(String(u.id)) || {};
    const attention = Array.isArray(insight.pontos_atencao) ? insight.pontos_atencao : [];
    const strengths = Array.isArray(insight.pontos_fortes) ? insight.pontos_fortes : [];
    const topIssue = attention[0] || null;
    const critical = u.status === 'critica';
    const declining = Number(u.tendencia_14d || 0) < -0.2;
    if (topIssue || critical || declining) {
      const priority = critical || (declining && Number(topIssue?.count || 0) >= 2) ? 'alta' : 'media';
      const title = topIssue?.tag
        ? `Corrigir ${topIssue.tag} — ${u.nome}`
        : `Recuperar desempenho — ${u.nome}`;
      result.push({
        id: `op-${u.id}-${topIssue?.tag || 'desempenho'}`,
        unidade_id: u.id,
        unidade: u.nome,
        prioridade: priority,
        titulo: title,
        problema: topIssue?.tag
          ? `Tema recorrente em ${topIssue.count} feedback(s) negativo(s).`
          : declining
            ? `Nota caiu ${Math.abs(Number(u.tendencia_14d || 0)).toFixed(1)} ponto(s) nos últimos 14 dias.`
            : 'Desempenho abaixo do esperado.',
        evidencia: {
          tag: topIssue?.tag || null,
          ocorrencias: Number(topIssue?.count || 0),
          nota: u.nota,
          tendencia_14d: u.tendencia_14d,
          feedbacks: u.feedbacks,
        },
        acao_sugerida: actionFor(topIssue?.tag || '', critical),
      });
    }
    if (strengths[0] && Number(u.nota || 0) >= 4.5 && Number(u.tendencia_14d || 0) >= 0) {
      result.push({
        id: `bp-${u.id}-${strengths[0].tag}`,
        unidade_id: u.id,
        unidade: u.nome,
        prioridade: 'oportunidade',
        titulo: `Replicar ${strengths[0].tag} — ${u.nome}`,
        problema: 'Prática com sinal positivo e potencial de replicação entre unidades.',
        evidencia: {
          tag: strengths[0].tag,
          ocorrencias: Number(strengths[0].count || 0),
          nota: u.nota,
          tendencia_14d: u.tendencia_14d,
          feedbacks: u.feedbacks,
        },
        acao_sugerida: 'Identificar o que esta unidade faz diferente e transformar em prática replicável nas demais unidades.',
      });
    }
  }
  const order: Record<string, number> = { alta: 0, media: 1, oportunidade: 2 };
  return result
    .sort((a, b) => (order[a.prioridade] ?? 9) - (order[b.prioridade] ?? 9) || Number(b.evidencia.ocorrencias || 0) - Number(a.evidencia.ocorrencias || 0))
    .slice(0, 12);
}


export function radarEstrategico(reviews: any[], ranking: any[]) {
  const real = (reviews || []).filter((r: any) => !r.is_test);
  const positiveThemes: Record<string, number> = {};
  const negativeThemes: Record<string, number> = {};
  const requestThemes: Record<string, number> = {};
  let riskClients = 0;
  const requestPattern = /\b(quero|queria|gostaria|poderia|poderiam|deveria|deveriam|sugest[aã]o|faltou|falta|seria bom|mais)\b/i;

  for (const r of real) {
    const rating = Number(r.rating || 0);
    const tags = Array.isArray(r.ai_tags) ? r.ai_tags : [];
    const target = rating >= 4 ? positiveThemes : rating <= 3 ? negativeThemes : null;
    for (const tag of tags) {
      const key = String(tag || '').trim();
      if (!key) continue;
      if (target) target[key] = (target[key] || 0) + 1;
      if (requestPattern.test(String(r.comment || ''))) requestThemes[key] = (requestThemes[key] || 0) + 1;
    }
    if (rating <= 2 || String(r.sentiment || '').toLowerCase() === 'negativo') riskClients += 1;
  }

  const top = (source: Record<string, number>, limit = 5) => Object.entries(source)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tema, ocorrencias]) => ({ tema, ocorrencias }));

  const bestUnit = [...(ranking || [])].filter((u: any) => u.feedbacks > 0).sort((a, b) => b.nota - a.nota)[0] || null;
  const worstUnit = [...(ranking || [])].filter((u: any) => u.feedbacks > 0).sort((a, b) => a.nota - b.nota)[0] || null;
  const recentCut = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const recentNegative = real.filter((r: any) => Number(r.rating || 0) <= 3 && new Date(rowCreatedAt(r)).getTime() >= recentCut).length;
  const previousNegative = real.filter((r: any) => {
    const t = new Date(rowCreatedAt(r)).getTime();
    return Number(r.rating || 0) <= 3 && t < recentCut && t >= recentCut - 14 * 24 * 60 * 60 * 1000;
  }).length;

  const growthSignals = Object.entries(requestThemes)
    .map(([tema, ocorrencias]) => {
      const normalized = tema.toLowerCase();
      const type = /produto|servi|plano|categoria|opção|opcao/.test(normalized)
        ? 'demanda'
        : /mais|adicion|novo|nova|expand|ampli/.test(normalized)
          ? 'expansao'
          : 'melhoria';
      return { tema, ocorrencias, tipo: type, potencial: ocorrencias >= 3 ? 'alto' : ocorrencias >= 2 ? 'medio' : 'incipiente' };
    })
    .sort((a, b) => b.ocorrencias - a.ocorrencias)
    .slice(0, 8);

  return {
    oportunidades: growthSignals.filter((x) => x.tipo !== 'melhoria'),
    sinais_crescimento: growthSignals,
    temas_criticos: top(negativeThemes),
    pedidos_clientes: top(requestThemes),
    risco: {
      clientes_em_risco: riskClients,
      negativas_14d: recentNegative,
      variacao_negativas_14d: recentNegative - previousNegative,
      unidade_critica: worstUnit ? { id: worstUnit.id, nome: worstUnit.nome, nota: worstUnit.nota } : null,
    },
    crescimento: {
      unidade_referencia: bestUnit ? { id: bestUnit.id, nome: bestUnit.nome, nota: bestUnit.nota } : null,
      unidades: (ranking || []).filter((u: any) => u.feedbacks > 0).length,
      feedbacks_analisados: real.length,
    },
  };
}


export function oportunidadesEstrategicas(reviews: any[], ranking: any[]) {
  const real = (reviews || []).filter((r: any) => !r.is_test);
  const now = Date.now();
  const recentCut = now - 14 * 24 * 60 * 60 * 1000;
  const previousCut = now - 28 * 24 * 60 * 60 * 1000;
  const unitById = new Map((ranking || []).map((u: any) => [String(u.id), u]));
  const stats = new Map<string, {
    ocorrencias: number;
    unidades: Set<string>;
    recentes: number;
    anteriores: number;
    pedidos: number;
    somaNota: number;
    negativas: number;
    positivas: number;
  }>();

  const requestPattern = /\b(quero|queria|gostaria|poderia|poderiam|deveria|deveriam|sugest[aã]o|faltou|falta|seria bom|mais)\b/i;

  for (const r of real) {
    const t = new Date(rowCreatedAt(r)).getTime();
    const recent = Number.isFinite(t) && t >= recentCut;
    const previous = Number.isFinite(t) && t >= previousCut && t < recentCut;
    const rating = Number(r.rating || 0);
    const request = requestPattern.test(String(r.comment || ''));
    const unitId = String(r.unidade_id || '');
    const tags = Array.isArray(r.ai_tags) ? r.ai_tags : [];

    for (const rawTag of tags) {
      const tema = String(rawTag || '').trim();
      if (!tema) continue;
      const current = stats.get(tema) || {
        ocorrencias: 0,
        unidades: new Set<string>(),
        recentes: 0,
        anteriores: 0,
        pedidos: 0,
        somaNota: 0,
        negativas: 0,
        positivas: 0,
      };
      current.ocorrencias += 1;
      if (unitId) current.unidades.add(unitId);
      if (recent) current.recentes += 1;
      if (previous) current.anteriores += 1;
      if (request) current.pedidos += 1;
      current.somaNota += rating;
      if (rating <= 3) current.negativas += 1;
      if (rating >= 4) current.positivas += 1;
      stats.set(tema, current);
    }
  }

  const totalUnits = Math.max(1, (ranking || []).filter((u: any) => u.feedbacks > 0).length);
  const maxRecent = Math.max(1, ...[...stats.values()].map((s) => s.recentes));
  const maxRequests = Math.max(1, ...[...stats.values()].map((s) => s.pedidos));

  const result = [...stats.entries()].map(([tema, s]) => {
    const abrangencia = Math.min(20, Math.round((s.unidades.size / totalUnits) * 20));
    const recorrencia = Math.min(30, s.ocorrencias * 4);
    const tendenciaBruta = s.recentes - s.anteriores;
    const tendencia = Math.max(0, Math.min(20, Math.round((tendenciaBruta / maxRecent) * 20)));
    const sinalPedido = Math.min(20, Math.round((s.pedidos / maxRequests) * 20));
    const mediaNota = s.ocorrencias ? s.somaNota / s.ocorrencias : 0;
    const impactoNota = mediaNota <= 3 ? 10 : mediaNota < 3.5 ? 8 : mediaNota < 4 ? 5 : 2;
    const score = Math.max(0, Math.min(100, recorrencia + abrangencia + tendencia + sinalPedido + impactoNota));
    const normalized = tema.toLowerCase();

    let tipo: 'demanda' | 'expansao' | 'retencao' | 'operacao' | 'replicacao';
    let impactoNegocio: string;
    let acaoRecomendada: string;

    if (s.pedidos >= 2 && /produto|servi|plano|categoria|opção|opcao|novo|nova|adicion/.test(normalized)) {
      tipo = 'demanda';
      impactoNegocio = 'Potencial de expansão de receita a partir de uma demanda recorrente dos clientes.';
      acaoRecomendada = 'Validar a demanda, dimensionar interesse e testar uma oferta antes de ampliar a operação.';
    } else if (s.positivas >= s.negativas * 2 && mediaNota >= 4.5 && s.unidades.size >= 1) {
      tipo = 'replicacao';
      impactoNegocio = 'Potencial de ganho operacional ao replicar uma prática que já funciona.';
      acaoRecomendada = 'Identificar a prática associada ao tema e replicá-la nas unidades com menor desempenho.';
    } else if (s.negativas >= Math.max(2, s.positivas) && mediaNota <= 3.5) {
      tipo = 'retencao';
      impactoNegocio = 'Risco de perda de clientes e redução de recorrência se o problema persistir.';
      acaoRecomendada = 'Priorizar a correção da causa e acompanhar a recuperação da nota e dos sinais negativos.';
    } else if (s.pedidos >= 2) {
      tipo = 'expansao';
      impactoNegocio = 'Sinal de oportunidade comercial ou de ampliação da oferta.';
      acaoRecomendada = 'Testar uma iniciativa comercial ou operacional associada ao tema e medir adesão.';
    } else {
      tipo = 'operacao';
      impactoNegocio = 'Potencial de ganho de eficiência, satisfação e retorno ao corrigir um tema recorrente.';
      acaoRecomendada = 'Criar uma ação operacional mensurável e acompanhar o efeito nas unidades afetadas.';
    }

    const unidadesAfetadas = [...s.unidades]
      .map((id) => unitById.get(id))
      .filter(Boolean)
      .sort((a: any, b: any) => Number(b.feedbacks || 0) - Number(a.feedbacks || 0))
      .slice(0, 8)
      .map((u: any) => ({ id: u.id, nome: u.nome, nota: u.nota }));

    return {
      id: `opp-${tema.toLowerCase().replace(/[^a-z0-9à-ÿ]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60)}`,
      tipo,
      titulo: tipo === 'demanda'
        ? `Explorar demanda por ${tema}`
        : tipo === 'replicacao'
          ? `Replicar força em ${tema}`
          : tipo === 'retencao'
            ? `Reduzir risco em ${tema}`
            : tipo === 'expansao'
              ? `Expandir oportunidade em ${tema}`
              : `Melhorar operação em ${tema}`,
      score,
      potencial: score >= 70 ? 'alto' : score >= 45 ? 'medio' : 'baixo',
      evidencias: {
        ocorrencias: s.ocorrencias,
        unidades_afetadas: s.unidades.size,
        tendencia_14d: tendenciaBruta,
        pedidos_clientes: s.pedidos,
        media_nota: Math.round(mediaNota * 10) / 10,
      },
      impacto_negocio: impactoNegocio,
      acao_recomendada: acaoRecomendada,
      unidades_afetadas: unidadesAfetadas,
    };
  });

  return result
    .filter((x) => x.evidencias.ocorrencias >= 2 || x.evidencias.pedidos_clientes >= 1)
    .sort((a, b) => b.score - a.score || b.evidencias.ocorrencias - a.evidencias.ocorrencias)
    .slice(0, 10);
}

function podeGerirEmpresa(req: AuthRequest, empresaId: string): boolean {
  if (isAdminUser(req.user)) return true;
  return Boolean(req.user?.empresa_id && req.user.empresa_id === empresaId);
}

async function ensurePainelColumns(db: any) {
  try {
    await ensureReviewFraudColumns(db);
  } catch (e: any) {
    console.warn('ensureReviewFraudColumns:', e?.message || e);
  }
  try {
    await ensureReviewTreatmentColumns(db);
  } catch (e: any) {
    console.warn('ensureReviewTreatmentColumns:', e?.message || e);
  }
  const extras = [
    'sentiment TEXT',
    'sentiment_score DOUBLE PRECISION',
    'sentiment_source TEXT',
    'is_test INTEGER DEFAULT 0',
    'fraud_flags TEXT',
    'origin TEXT',
    'client_whatsapp TEXT',
    'unidade_id TEXT',
    'treated_at TIMESTAMPTZ',
    'treated_note TEXT',
  ];
  for (const ddl of extras) {
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
}

const PAINEL_RECENTES_LIMIT = 500;

async function loadReviewsSafe(db: any, empresaId: string, limit: number): Promise<any[]> {
  const safeLimit = Math.max(1, Math.min(8000, Math.floor(Number(limit) || 500)));
  const queries = [
    `SELECT * FROM reviews WHERE empresa_id = ? ORDER BY createdAt DESC NULLS LAST LIMIT ${safeLimit}`,
    `SELECT * FROM reviews WHERE empresa_id = ? ORDER BY "createdAt" DESC LIMIT ${safeLimit}`,
    `SELECT * FROM reviews WHERE empresa_id = ? ORDER BY id DESC LIMIT ${safeLimit}`,
    `SELECT * FROM reviews WHERE empresa_id = ? LIMIT ${safeLimit}`,
  ];
  for (const q of queries) {
    try {
      const rows = await db.all(q, [empresaId]);
      return Array.isArray(rows) ? rows : [];
    } catch (e: any) {
      console.warn('painel reviews query fail:', e?.message || e, q.slice(0, 80));
    }
  }
  return [];
}

function emptyPainelPayload(empresa: any, reason?: string) {
  const base = APP_URL.replace(/\/$/, '');
  const ref = empresa.slug || empresa.id;
  const plan = String(empresa.plan || 'trial').toLowerCase();
  const trial = isTrialPlan(plan);
  const nivel = nivelDashboard(plan);
  const pdf_disponivel = planTemPdf(plan);
  const tem_ia = trial || planTemIA(plan);
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
      unidades_ranking: [],
      unidades_resumo: { total_unidades: 0, unidades_com_dados: 0, melhor_unidade: null, unidade_atencao: null, maior_evolucao: null, maior_queda: null },
      unidades_insights: [],
      prioridades_operacionais: [],
      radar_estrategico: null,
      oportunidades_estrategicas: [],
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
      nivel,
      pdf_disponivel,
      tem_ia,
      trial_completo: trial,
      plan_switch: allowPlanSwitch(),
      planos_teste: allowPlanSwitch()
        ? PLANOS_OFICIAIS.map((p) => ({ key: p, label: planLabel(p) }))
        : [],
      mostrar_graficos: true,
      mostrar_tendencia: trial || nivel === 'pro' || nivel === 'ultra' || nivel === 'executivo',
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
      relatorio_pdf: pdf_disponivel ? `/api/empresa/${ref}/relatorio.pdf` : null,
      login: `${base}/login`,
    },
    ...(reason ? { _degraded: true, _reason: String(reason).slice(0, 200) } : {}),
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
            'Troca de plano de teste desativada em produção. Use Stripe/checkout ou defina ALLOW_PLAN_SWITCH=1.',
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

      res.json({
        success: true,
        plan,
        status,
        expira_em: expira,
        mensagem: `Plano ${planLabel(plan)} ativo (modo teste — sem cobrança).`,
        pdf_disponivel: planTemPdf(plan),
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
          await ensurePainelColumns(db);
        } catch (e: any) {
          console.warn('ensurePainelColumns:', e?.message || e);
        }

        const planAtual = String(empresa.plan || 'trial').toLowerCase();
        // A análise respeita a capacidade do plano; a UI recebe apenas os feedbacks recentes.
        const rows = await loadReviewsSafe(db, empresa.id, getFeedbackLimit(planAtual));

        // Pre-generated monthly snapshots are returned with the existing panel payload.
        let relatoriosProfissionaisMensais: any[] = [];
        if (['pro', 'ultra', 'corporativo', 'corporate', 'corp', 'rei'].includes(planAtual)) {
          try {
            const savedReports = await db.all(
              `SELECT periodo, report_json, status, updated_at
               FROM relatorio_envios_mensais
               WHERE empresa_id = ? AND report_json IS NOT NULL
               ORDER BY periodo DESC LIMIT 24`,
              [empresa.id],
            ) as any[];
            relatoriosProfissionaisMensais = savedReports.flatMap((item: any) => {
              try {
                const report = JSON.parse(String(item.report_json || ''));
                if (!report || report.empresa?.id !== String(empresa.id) || report.periodo !== String(item.periodo)) return [];
                return [{ ...report, status_distribuicao: item.status, gerado_em: item.updated_at }];
              } catch {
                return [];
              }
            });
          } catch (e: any) {
            // Older installations may not have run the monthly job/schema migration yet.
            console.warn('relatorios profissionais mensais indisponíveis:', e?.message || e);
          }
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
          const createdAt = rowCreatedAt(r);
          const clientWpp =
            r.client_whatsapp === '[anonimizado]'
              ? null
              : normalizarWhatsapp(r.client_whatsapp);

          let textoWpp = '';
          try {
            textoWpp = mensagemEmpresaParaCliente({
              nomeEmpresa: empresa.nome_empresa,
              nomeCliente: r.name,
              rating: Number(r.rating),
              comment: r.comment ? String(r.comment) : undefined,
            });
          } catch {
            textoWpp = '';
          }

          return {
            id: r.id,
            name: r.name,
            rating: r.rating,
            comment: r.comment,
            ai_reply: planTemIA(planAtual) ? r.ai_reply : null,
            ai_tags: planTemIA(planAtual) ? tags : [],
            createdAt,
            is_test: Number(r.is_test) === 1,
            fraud_flags: r.fraud_flags || null,
            origin: r.origin || 'publico',
            sentiment: r.sentiment || null,
            sentiment_score: r.sentiment_score != null ? Number(r.sentiment_score) : null,
            sentiment_source: planTemIA(planAtual) ? (r.sentiment_source || null) : null,
            unidade_id: r.unidade_id || null,
            client_whatsapp: clientWpp,
            client_whatsapp_url: linkWhatsapp(clientWpp, textoWpp),
            client_whatsapp_anon: r.client_whatsapp === '[anonimizado]',
            treated_at: r.treated_at || null,
            treated_note: r.treated_note || null,
            treated: Boolean(r.treated_at),
          };
        });

        const reais = reviews.filter((r) => !r.is_test);
        let unidadesRanking: any[] = [];
        let unidadesInsights: any[] = [];
        let unidadesResumo: any = { total_unidades: 0, unidades_com_dados: 0, melhor_unidade: null, unidade_atencao: null, maior_evolucao: null, maior_queda: null };
        if (planAtual === 'corporativo' || planAtual === 'rei' || isTrialPlan(planAtual)) {
          try {
            await ensureUnidadesSchema(db);
            const unidades = await db.all(`SELECT id, nome, cidade FROM unidades WHERE empresa_id = ? AND COALESCE(ativo, 1) = 1 ORDER BY nome ASC`, [empresa.id]);
            unidadesRanking = unidadeRanking(reviews, unidades || []);
            unidadesInsights = insightsOperacionaisPorUnidade(reviews, unidadesRanking);
            unidadesResumo = resumoUnidades(unidadesRanking);
          } catch (e: any) {
            console.warn('unidades ranking:', e?.message || e);
          }
        }
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
        const crises_24h = reais.filter(
          (r: any) => r.rating <= 2 && new Date(r.createdAt).getTime() >= ha24h
        ).length;

        const tagCount: Record<string, number> = {};
        for (const r of reais) {
          for (const t of r.ai_tags || []) {
            const k = String(t);
            tagCount[k] = (tagCount[k] || 0) + 1;
          }
        }
        const top_tags = planTemIA(planAtual) ? Object.entries(tagCount)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([tag, count]) => ({ tag, count })) : [];

        const serie_14d = serieUltimosDias(reais, 14);

        const plan = String(empresa.plan || 'trial').toLowerCase();
        const trial = isTrialPlan(plan);
        const nivel = nivelDashboard(plan);
        const pdf_disponivel = planTemPdf(plan);
        const tem_ia = trial || planTemIA(plan);

        let feedback_usados = 0;
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

        const base = APP_URL.replace(/\/$/, '');
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

        return res.json({
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
          reviews: reais.slice(0, PAINEL_RECENTES_LIMIT),
          relatorios_profissionais_mensais: relatoriosProfissionaisMensais,
          reviews_total: total,
          metricas: {
        unidades_ranking: unidadesRanking,
            unidades_resumo: unidadesResumo,
            unidades_insights: (planAtual === 'corporativo' || planAtual === 'rei') ? unidadesInsights : [],
            prioridades_operacionais: (planAtual === 'corporativo' || planAtual === 'rei') ? prioridadesOperacionaisPorUnidade(unidadesRanking, unidadesInsights) : [],
            radar_estrategico: planAtual === 'rei' ? radarEstrategico(reviews, unidadesRanking) : null,
            oportunidades_estrategicas: planAtual === 'rei' ? oportunidadesEstrategicas(reviews, unidadesRanking) : [],
            total,
            media,
            negativas,
            positivas,
            tratadas,
            pendentes_tratamento: Math.max(0, negativas - tratadas),
            alerta_crise: crises_24h >= 3,
            crises_24h,
            distribuicao: dist,
            top_tags,
            taxa_positiva: total ? Math.round((positivas / total) * 100) : 0,
            serie_14d,
            testes_excluidos: reviews.length - reais.length,
            sentimento_mix,
            sentimento_score_medio: scoreN ? Math.round((scoreSum / scoreN) * 100) / 100 : null,
            feedback_usados,
            feedback_limite,
            tokens_usados: token_usados,
            tokens_limite: token_limite,
            tokens_pct: token_limite > 0 ? Math.min(100, Math.round((token_usados / token_limite) * 100)) : 0,
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
            mostrar_tendencia: trial || nivel === 'pro' || nivel === 'ultra' || nivel === 'executivo',
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
            relatorio_pdf: pdf_disponivel ? `/api/empresa/${ref}/relatorio.pdf` : null,
            login: `${base}/login`,
          },
        });
      } catch (e: any) {
        console.error('painel error:', e?.message || e);
        return res.json(emptyPainelPayload(empresa, e?.message || 'degraded'));
      }
    })
  );
}
