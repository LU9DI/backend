/**
 * Relatório profissional — JSON-first, determinístico e pronto para canais.
 *
 * O relatório é um objeto de negócio, não um arquivo. A mesma estrutura
 * alimenta painel, e-mail, WhatsApp, SMS/WeChat e futuras camadas de IA.
 */
import type { Database } from 'sqlite';
import { planLabel, PLANOS_OFICIAIS } from '../lib/plans.js';

export type ReportChannel = 'email' | 'whatsapp' | 'sms' | 'wechat';

export type RelatorioDestino = {
  canal: ReportChannel;
  destino: string;
};

type Review = {
  id?: string;
  rating?: unknown;
  unidade_id?: string | null;
  createdAt?: unknown;
  created_at?: unknown;
  createdat?: unknown;
  is_test?: unknown;
  ai_tags?: unknown;
  sentiment?: unknown;
  treated_at?: unknown;
};

const PLAN_BENEFITS: Record<string, string[]> = {
  inicial: [
    'Até 100 feedbacks por ciclo',
    'Dashboard operacional',
    'WhatsApp integrado',
  ],
  pro: [
    'Até 300 feedbacks por ciclo',
    'Dashboard operacional',
    'WhatsApp integrado',
    'Relatório profissional do período',
  ],
  ultra: [
    'Até 800 feedbacks por ciclo',
    'Tudo do Pro',
    'IA integrada',
    'Dashboard com análises avançadas',
    'Relatório profissional com sentimento e temas',
  ],
  corporativo: [
    'Até 2.500 feedbacks por ciclo',
    'Tudo do Ultra',
    'Dashboard multiunidades',
    'Ranking das unidades',
    'Insights operacionais por unidade',
    'Prioridades operacionais',
    'Links de avaliação por unidade',
    'Suporte prioritário',
    'Acesso antecipado a novas funções',
  ],
  rei: [
    'Até 8.000 feedbacks por ciclo',
    'Tudo do Corporativo',
    'Radar estratégico',
    'Oportunidades de crescimento',
    'Relatório executivo completo',
    'Visão consolidada para diretoria e gestão',
    'Suporte prioritário',
    'Acesso antecipado a novas funções',
  ],
};

const PLAN_ORDER = ['inicial', 'pro', 'ultra', 'corporativo', 'rei'];

function normalizePlan(value: unknown): string {
  const p = String(value || '').trim().toLowerCase();
  if (p === 'corp' || p === 'corporate') return 'corporativo';
  if (p === 'teste' || p === 'test' || p.startsWith('trial')) return 'rei';
  return PLANOS_OFICIAIS.includes(p as any) ? p : 'pro';
}

function planBenefits(plan: string): string[] {
  const normalized = normalizePlan(plan);
  return PLAN_BENEFITS[normalized] || PLAN_BENEFITS.pro;
}

function nextPlan(plan: string): string | null {
  const normalized = normalizePlan(plan);
  const index = PLAN_ORDER.indexOf(normalized);
  return index >= 0 && index < PLAN_ORDER.length - 1 ? PLAN_ORDER[index + 1] : null;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function dateOf(row: Review): string {
  return String(row.createdAt ?? row.createdat ?? row.created_at ?? '');
}

function isTest(row: Review): boolean {
  return Number(row.is_test) === 1 || row.is_test === true || String(row.is_test).toLowerCase() === 'true';
}

function percent(value: number, total: number): number {
  return total ? Math.round((value / total) * 100) : 0;
}

function tags(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed || '[]'); } catch { parsed = []; }
  }
  return Array.isArray(parsed)
    ? parsed.map(String).map((x) => x.trim()).filter(Boolean)
    : [];
}

function sentiment(row: Review): 'positivo' | 'neutro' | 'negativo' {
  const raw = String(row.sentiment || '').toLowerCase();
  if (raw.includes('pos')) return 'positivo';
  if (raw.includes('neg')) return 'negativo';
  if (raw.includes('neu')) return 'neutro';
  const rating = Number(row.rating);
  if (rating >= 4) return 'positivo';
  if (rating <= 2) return 'negativo';
  return 'neutro';
}

function summarizeThemes(rows: Review[], positive: boolean): Array<{ tema: string; volume: number }> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const rating = Number(row.rating);
    const belongs = positive ? rating >= 4 : rating <= 3;
    if (!belongs) continue;
    for (const tag of tags(row.ai_tags)) map.set(tag, (map.get(tag) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([tema, volume]) => ({ tema, volume }));
}

function buildSummary(plan: string, kpi: any): string {
  if (!kpi.avaliacoes) {
    return 'Não houve avaliações válidas no período. O relatório está pronto para receber dados assim que novas avaliações entrarem no painel.';
  }
  const quality =
    kpi.nota_media >= 4.5 ? 'desempenho excelente' :
    kpi.nota_media >= 4 ? 'desempenho positivo' :
    kpi.nota_media >= 3 ? 'desempenho estável, com pontos de atenção' :
    'cenário que merece atenção prioritária';
  const plan = planLabel(plan);
  return `No período analisado, o ${plan} registrou ${kpi.avaliacoes} avaliações, nota média de ${kpi.nota_media.toFixed(1)} e ${kpi.percentual_positivas}% de avaliações positivas. O cenário indica ${quality}.`;
}

function buildRecommendations(kpi: any, themes: any): string[] {
  const out: string[] = [];
  if (kpi.criticas > 0) out.push(`Priorizar o tratamento das ${kpi.criticas} avaliações críticas (1–2 estrelas).`);
  if (kpi.percentual_positivas < 80) out.push('Investigar os principais temas associados às avaliações não positivas.');
  if (themes.length) out.push(`Acompanhar o tema recorrente “${themes[0].tema}” e validar a causa na operação.`);
  if (!out.length) out.push('Manter o acompanhamento periódico e comparar a evolução com o próximo ciclo.');
  return out.slice(0, 4);
}

function channelTexts(report: any) {
  const headline = report.resumo_executivo;
  const k = report.kpis;
  const recs = report.recomendacoes.map((x: string) => `• ${x}`).join('\n');
  const benefits = report.plano.beneficios_incluidos.slice(0, 5).map((x: string) => `• ${x}`).join('\n');
  const text = [
    `Filtra.AI — Relatório profissional | ${report.periodo}`,
    report.empresa.nome,
    '',
    headline,
    '',
    `KPIs: ${k.avaliacoes} avaliações · média ${k.nota_media.toFixed(1)} · ${k.percentual_positivas}% positivas · ${k.criticas} críticas`,
    '',
    'Recomendações:',
    recs,
    '',
    `Seu plano (${report.plano.nome}) inclui:`,
    benefits,
  ].join('\n');

  const compact = `Filtra.AI | ${report.empresa.nome} | ${report.periodo}: ${k.avaliacoes} avaliações, média ${k.nota_media.toFixed(1)}, ${k.percentual_positivas}% positivas, ${k.criticas} críticas. ${report.recomendacoes[0]}`;
  const whatsapp = text.length > 3800 ? `${text.slice(0, 3700)}…` : text;
  const sms = compact.length > 300 ? `${compact.slice(0, 297)}…` : compact;

  return {
    email: {
      subject: `Filtra.AI — Relatório profissional · ${report.periodo} · ${report.empresa.nome}`,
      text,
      html: `<article style="font-family:Arial,sans-serif;max-width:760px;margin:auto;color:#172033"><h1>Relatório profissional</h1><p><strong>${escapeHtml(report.empresa.nome)}</strong> · ${escapeHtml(report.periodo)}</p><p>${escapeHtml(headline)}</p><h2>Indicadores</h2><ul><li>${k.avaliacoes} avaliações</li><li>Nota média: <strong>${k.nota_media.toFixed(1)}</strong></li><li>${k.percentual_positivas}% positivas</li><li>${k.criticas} críticas</li></ul><h2>O que fazer agora</h2><ul>${report.recomendacoes.map((x: string) => `<li>${escapeHtml(x)}</li>`).join('')}</ul><h2>Benefícios do plano ${escapeHtml(report.plano.nome)}</h2><ul>${report.plano.beneficios_incluidos.map((x: string) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></article>`,
    },
    whatsapp,
    sms,
    wechat: whatsapp,
  };
}

export async function buildRelatorioProfissional(
  db: Database,
  empresa: { id: string; nome_empresa?: string; plan?: string; slug?: string },
  mesAno?: string | null,
) {
  const periodo = mesAno && /^\d{4}-\d{2}$/.test(mesAno)
    ? mesAno
    : new Date().toISOString().slice(0, 7);
  const plan = normalizePlan(empresa.plan);
  let rows: Review[] = [];
  try {
    rows = await db.all(
      'SELECT * FROM reviews WHERE empresa_id = ? ORDER BY createdAt DESC LIMIT 10000',
      [empresa.id],
    ) as Review[];
  } catch {
    try {
      rows = await db.all(
        'SELECT * FROM reviews WHERE empresa_id = ? ORDER BY created_at DESC LIMIT 10000',
        [empresa.id],
      ) as Review[];
    } catch { rows = []; }
  }

  const reais = rows.filter((row) => !isTest(row) && dateOf(row).startsWith(periodo));
  const avaliacoes = reais.length;
  const soma = reais.reduce((sum, row) => sum + Number(row.rating || 0), 0);
  const notaMedia = avaliacoes ? Math.round((soma / avaliacoes) * 10) / 10 : 0;
  const positivas = reais.filter((row) => Number(row.rating) >= 4).length;
  const criticas = reais.filter((row) => Number(row.rating) <= 2).length;
  const tratadas = reais.filter((row) => row.treated_at && Number(row.rating) <= 3).length;
  const distribuicao = [1, 2, 3, 4, 5].map((rating) => reais.filter((row) => Number(row.rating) === rating).length);
  const sent = reais.reduce((acc, row) => {
    const key = sentiment(row);
    acc[key] += 1;
    return acc;
  }, { positivo: 0, neutro: 0, negativo: 0 } as Record<string, number>);
  const temasPositivos = summarizeThemes(reais, true);
  const temasAtencao = summarizeThemes(reais, false);
  const kpis = {
    avaliacoes,
    nota_media: notaMedia,
    positivas,
    criticas,
    tratadas,
    percentual_positivas: percent(positivas, avaliacoes),
    percentual_criticas: percent(criticas, avaliacoes),
  };

  let unidades: any[] = [];
  if (['corporativo', 'rei'].includes(plan)) {
    try {
      const raw = await db.all(
        'SELECT id, nome FROM unidades WHERE empresa_id = ? AND (ativo IS NULL OR ativo = 1 OR ativo = true) ORDER BY nome',
        [empresa.id],
      ) as any[];
      unidades = raw.map((u) => {
        const reviews = reais.filter((r) => String(r.unidade_id || '') === String(u.id));
        const total = reviews.length;
        const avg = total ? Math.round((reviews.reduce((s, r) => s + Number(r.rating || 0), 0) / total) * 10) / 10 : 0;
        return { id: u.id, nome: u.nome, avaliacoes: total, nota_media: avg, criticas: reviews.filter((r) => Number(r.rating) <= 2).length };
      }).filter((u) => u.avaliacoes > 0);
    } catch { unidades = []; }
  }

  const riscos = [];
  if (kpis.percentual_criticas >= 20) riscos.push({ nivel: 'alto', titulo: 'Concentração de avaliações críticas', evidencias: `${kpis.percentual_criticas}% das avaliações são críticas.` });
  if (sent.negativo > sent.positivo) riscos.push({ nivel: 'medio', titulo: 'Sentimento negativo predominante', evidencias: 'O volume de sinais negativos supera o positivo no período.' });
  if (plan === 'rei' && unidades.length) {
    const worst = [...unidades].sort((a, b) => a.nota_media - b.nota_media)[0];
    if (worst) riscos.push({ nivel: 'medio', titulo: `Unidade com menor nota: ${worst.nome}`, evidencias: `Média ${worst.nota_media.toFixed(1)} com ${worst.avaliacoes} avaliações.` });
  }

  const oportunidades = [];
  if (kpis.percentual_positivas >= 80) oportunidades.push({ titulo: 'Fortalecer os pontos positivos', evidencias: `${kpis.percentual_positivas}% das avaliações estão em 4–5 estrelas.` });
  if (temasPositivos.length) oportunidades.push({ titulo: `Escalar o tema positivo “${temasPositivos[0].tema}”`, evidencias: `${temasPositivos[0].volume} ocorrências associadas.` });
  if (plan === 'rei') oportunidades.push({ titulo: 'Conectar sinais de reputação a decisões de gestão', evidencias: 'O plano REI consolida indicadores, riscos, oportunidades e recomendações em visão executiva.' });

  const baseReport: any = {
    schema_version: '2.0',
    tipo: 'relatorio_profissional',
    geracao: { modo: 'deterministico', modelo_ia: null, tokens: 0 },
    empresa: { id: String(empresa.id), nome: String(empresa.nome_empresa || 'Empresa'), slug: empresa.slug || null },
    periodo,
    plano: {
      codigo: plan,
      nome: planLabel(plan),
      beneficios_incluidos: planBenefits(plan),
      proximo_plano: nextPlan(plan),
      comparativo: PLAN_ORDER.map((p) => ({
        codigo: p,
        nome: planLabel(p),
        beneficios: PLAN_BENEFITS[p],
      })),
    },
    resumo_executivo: buildSummary(plan, kpis),
    kpis,
    distribuicao_estrelas: distribuicao,
    sentimento: sent,
    temas: { positivos: temasPositivos, atencao: temasAtencao },
    unidades,
    riscos,
    oportunidades,
    recomendacoes: buildRecommendations(kpis, temasAtencao),
    narrativa: {
      o_que_aconteceu: buildSummary(plan, kpis),
      por_que_importa: kpis.percentual_criticas > 0
        ? `Há ${kpis.criticas} avaliações críticas que podem indicar pontos de atrito na experiência.`
        : 'Os sinais disponíveis não mostram concentração relevante de avaliações críticas.',
      onde_atuar: unidades.length
        ? `Priorizar a leitura comparativa das ${unidades.length} unidades com avaliações no período.`
        : 'Atuar primeiro sobre os temas recorrentes e avaliações críticas do conjunto da empresa.',
      riscos: riscos.map((x: any) => x.titulo),
      oportunidades: oportunidades.map((x: any) => x.titulo),
      o_que_fazer_agora: buildRecommendations(kpis, temasAtencao),
    },
    origem: 'dados_reais_do_painel',
  };

  baseReport.canais = channelTexts(baseReport);
  return baseReport;
}

export function normalizeDestinatarios(body: any): RelatorioDestino[] {
  const out: RelatorioDestino[] = [];
  const seen = new Set<string>();
  const push = (canal: string, destino: string) => {
    const c = String(canal || '').toLowerCase().trim();
    const d = String(destino || '').trim();
    if (!d) return;
    const canalOk =
      c === 'email' || c === 'whatsapp' || c === 'sms' || c === 'wechat' || c === 'wpp'
        ? c === 'wpp' ? 'whatsapp' : c as ReportChannel
        : null;
    if (!canalOk) return;
    const key = `${canalOk}|${d.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ canal: canalOk, destino: d });
  };
  const list = body?.destinatarios || body?.destinations || [];
  if (Array.isArray(list)) for (const item of list) {
    if (typeof item === 'string') push(item.includes('@') ? 'email' : 'whatsapp', item);
    else if (item && typeof item === 'object') push(item.canal || item.channel || item.tipo, item.destino || item.to || item.value);
  }
  if (body?.email) push('email', String(body.email));
  if (body?.whatsapp) push('whatsapp', String(body.whatsapp));
  if (body?.sms) push('sms', String(body.sms));
  if (body?.wechat) push('wechat', String(body.wechat));
  return out.slice(0, 20);
}
