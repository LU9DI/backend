/**
 * Relatório PDF — Puppeteer, 1 layout por plano (benefícios reais).
 *
 * Pro   → 1 página: KPIs + barras
 * Ultra → + sentimento + temas IA (sempre, mesmo zerado)
 * Corp  → + página de filiais
 * Rei   → + fichas + destaques executivos
 * Trial → mesmo conteúdo Ultra (benefício do trial)
 */
import type { Database } from 'sqlite';
import puppeteer from 'puppeteer-core';
import { empresaTemPdf, isTrialPlan, planLabel } from './lib/plans.js';
import {
  subscriptionAnchorDay,
  cycleRangeForMonth,
  inCycleRange,
  type CycleRange,
} from './lib/billingCycle.js';

export type PdfDepth = 'pro' | 'ultra' | 'corp' | 'rei';

type Review = {
  rating: number;
  unidade_id?: string | null;
  origin?: string | null;
  createdAt?: string | Date;
  created_at?: string | Date;
  createdat?: string | Date;
  is_test?: number | boolean | null;
  ai_tags?: string | null;
  sentiment?: string | null;
};

type UnitRow = {
  nome: string;
  total: number;
  avg: number;
  critical: number;
  positive: number;
};

/** Benefícios oficiais espelhados no PDF */
const PLAN: Record<
  PdfDepth,
  {
    accent: string;
    soft: string;
    label: string;
    tagline: string;
    benefits: string[];
    notIncluded: string[];
  }
> = {
  pro: {
    accent: '#4f46e5',
    soft: '#eef2ff',
    label: 'PRO',
    tagline: 'Relatório essencial do ciclo',
    benefits: [
      'Volume de avaliações do ciclo',
      'Nota média e % positivas/críticas',
      'Gráfico de distribuição 1★ a 5★',
    ],
    notIncluded: [
      'Análise de sentimento (Ultra+)',
      'Temas detectados pela IA (Ultra+)',
      'Ranking de filiais (Corporativo+)',
    ],
  },
  ultra: {
    accent: '#0f766e',
    soft: '#f0fdfa',
    label: 'ULTRA',
    tagline: 'Essencial + inteligência de sentimento',
    benefits: [
      'Tudo do Pro',
      'Sentimento: positivo / neutro / negativo',
      'Temas principais detectados pela IA',
    ],
    notIncluded: [
      'Ranking de filiais (Corporativo+)',
      'Ficha detalhada por unidade (Rei)',
    ],
  },
  corp: {
    accent: '#1e40af',
    soft: '#eff6ff',
    label: 'CORPORATIVO',
    tagline: 'Multi-unidade e visão de rede',
    benefits: [
      'Tudo do Ultra',
      'Ranking de unidades / filiais',
      'Comparativo volume × nota × críticas',
    ],
    notIncluded: ['Ficha executiva por unidade (Rei)', 'Destaques automáticos da rede (Rei)'],
  },
  rei: {
    accent: '#92400e',
    soft: '#fffbeb',
    label: 'REI',
    tagline: 'Relatório executivo completo',
    benefits: [
      'Tudo do Corporativo',
      'Ficha de cada unidade',
      'Destaques: melhor e pior desempenho',
    ],
    notIncluded: [],
  },
};

export function depthForPlan(plan: string, trial: boolean): PdfDepth {
  if (trial) return 'ultra';
  const p = String(plan || '').toLowerCase().trim();
  if (p === 'rei') return 'rei';
  if (p === 'corporativo' || p === 'corporate') return 'corp';
  if (p === 'ultra') return 'ultra';
  if (p === 'pro') return 'pro';
  // inicial sem PDF; qualquer outro pago cai no pro
  return 'pro';
}

/** Permite admin testar layouts: pro|ultra|corp|rei */
export function parsePreviewDepth(raw: unknown): PdfDepth | null {
  const s = String(raw || '')
    .toLowerCase()
    .trim();
  if (s === 'pro' || s === 'ultra' || s === 'corp' || s === 'corporativo') {
    return s === 'corporativo' ? 'corp' : (s as PdfDepth);
  }
  if (s === 'rei') return 'rei';
  return null;
}

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isTest(r: Review) {
  return Number(r.is_test) === 1 || r.is_test === true;
}

function rowDate(r: Review): string | null {
  const d = r.createdAt ?? r.created_at ?? r.createdat;
  if (!d) return null;
  return typeof d === 'string' ? d : new Date(d).toISOString();
}

function avg(rs: Review[]) {
  if (!rs.length) return 0;
  return rs.reduce((s, r) => s + Number(r.rating || 0), 0) / rs.length;
}

function dist(rs: Review[]) {
  const a = [0, 0, 0, 0, 0];
  for (const r of rs) {
    const n = Number(r.rating);
    if (n >= 1 && n <= 5) a[n - 1] += 1;
  }
  return a;
}

function pct(n: number, t: number) {
  return t ? Math.round((n / t) * 100) : 0;
}

function sentimentBreak(rs: Review[]) {
  let pos = 0,
    neu = 0,
    neg = 0;
  for (const r of rs) {
    const s = String(r.sentiment || '').toLowerCase();
    if (s.includes('pos')) pos++;
    else if (s.includes('neg')) neg++;
    else if (s.includes('neu')) neu++;
    else {
      const n = Number(r.rating);
      if (n >= 4) pos++;
      else if (n <= 2) neg++;
      else neu++;
    }
  }
  return { pos, neu, neg };
}

function themes(rs: Review[]) {
  const m = new Map<string, number>();
  for (const r of rs) {
    if (!r.ai_tags) continue;
    try {
      const a = JSON.parse(String(r.ai_tags));
      if (Array.isArray(a)) {
        for (const t of a) {
          const k = String(t || '').trim();
          if (k) m.set(k, (m.get(k) || 0) + 1);
        }
      }
    } catch {
      /* */
    }
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag, count]) => ({ tag, count }));
}

async function loadReviews(db: Database, id: string, range: CycleRange): Promise<Review[]> {
  for (const q of [
    `SELECT * FROM reviews WHERE empresa_id = ?`,
    `SELECT rating, is_test, ai_tags, sentiment, unidade_id, origin, created_at FROM reviews WHERE empresa_id = ?`,
  ]) {
    try {
      const rows = (await db.all(q, [id])) as Review[];
      return (rows || []).filter((r) => !isTest(r) && inCycleRange(rowDate(r), range));
    } catch {
      /* */
    }
  }
  return [];
}

async function loadUnits(db: Database, id: string) {
  try {
    return (await db.all(
      `SELECT id, nome, slug FROM unidades WHERE empresa_id = ? AND (ativo IS NULL OR ativo = 1 OR ativo = true) ORDER BY nome`,
      [id]
    )) as any[];
  } catch {
    return [];
  }
}

function barsHtml(d: number[]) {
  const max = Math.max(...d, 1);
  const colors = ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'];
  return d
    .map((n, i) => {
      const w = Math.round((n / max) * 100);
      return `<div class="bar"><span>${i + 1}★</span><div class="track"><i style="width:${w}%;background:${colors[i]}"></i></div><b>${n}</b></div>`;
    })
    .join('');
}

function buildHtml(o: {
  empresa: string;
  planName: string;
  depth: PdfDepth;
  periodo: string;
  total: number;
  mean: number;
  positive: number;
  critical: number;
  dist: number[];
  sent: { pos: number; neu: number; neg: number };
  themes: { tag: string; count: number }[];
  units: UnitRow[];
  preview?: boolean;
}): string {
  const p = PLAN[o.depth];
  const ben = p.benefits.map((x) => `<li>✓ ${esc(x)}</li>`).join('');
  const not =
    p.notIncluded.length > 0
      ? p.notIncluded.map((x) => `<li>○ ${esc(x)}</li>`).join('')
      : '<li>✓ Nenhuma restrição — plano completo</li>';

  // —— seções por plano ——
  let body = `
  <section>
    <h2>Resumo do ciclo</h2>
    <div class="kpis">
      <div class="kpi"><em>Volume</em><strong>${o.total}</strong><small>avaliações</small></div>
      <div class="kpi"><em>Nota média</em><strong>${o.total ? o.mean.toFixed(1) : '—'}</strong><small>escala 1–5</small></div>
      <div class="kpi"><em>Positivas</em><strong>${o.positive}</strong><small>${pct(o.positive, o.total)}% · 4–5★</small></div>
      <div class="kpi"><em>Críticas</em><strong>${o.critical}</strong><small>${pct(o.critical, o.total)}% · 1–3★</small></div>
    </div>
  </section>
  <section>
    <h2>Distribuição de notas</h2>
    ${barsHtml(o.dist)}
  </section>`;

  if (o.depth === 'pro') {
    body += `
    <section class="notice">
      <h2>Limite do plano Pro</h2>
      <p>Este PDF mostra apenas o essencial. Com <b>Ultra</b> você ganha sentimento e temas da IA.
      Com <b>Corporativo</b> e <b>Rei</b>, entra a visão por filial.</p>
    </section>`;
  }

  if (o.depth === 'ultra' || o.depth === 'corp' || o.depth === 'rei') {
    body += `
    <section>
      <h2>Sentimento (benefício Ultra+)</h2>
      <div class="kpis3">
        <div class="kpi ok"><em>Positivo</em><strong>${o.sent.pos}</strong><small>${pct(o.sent.pos, o.total)}%</small></div>
        <div class="kpi warn"><em>Neutro</em><strong>${o.sent.neu}</strong><small>${pct(o.sent.neu, o.total)}%</small></div>
        <div class="kpi bad"><em>Negativo</em><strong>${o.sent.neg}</strong><small>${pct(o.sent.neg, o.total)}%</small></div>
      </div>
    </section>
    <section>
      <h2>Temas da IA (benefício Ultra+)</h2>
      ${
        o.themes.length
          ? `<table><thead><tr><th>Tema</th><th>Ocorrências</th></tr></thead><tbody>${o.themes
              .map((t) => `<tr><td>${esc(t.tag)}</td><td>${t.count}</td></tr>`)
              .join('')}</tbody></table>`
          : `<div class="empty">Nenhum tema neste ciclo ainda — a seção faz parte do seu plano e aparece assim que houver tags de IA.</div>`
      }
    </section>`;
  }

  if (o.depth === 'corp' || o.depth === 'rei') {
    body += `
    <section class="page-break">
      <h2>Ranking de unidades (benefício Corporativo+)</h2>
      ${
        o.units.length
          ? `<table><thead><tr><th>#</th><th>Unidade</th><th>Volume</th><th>Média</th><th>Críticas</th></tr></thead><tbody>${o.units
              .map(
                (u, i) =>
                  `<tr><td>${i + 1}</td><td>${esc(u.nome)}</td><td>${u.total}</td><td><b>${u.avg.toFixed(1)}</b></td><td>${u.critical}</td></tr>`
              )
              .join('')}</tbody></table>`
          : `<div class="empty">Nenhuma filial com avaliações neste ciclo. Cadastre unidades no painel — esta página existe porque seu plano inclui multi-unidade.</div>`
      }
    </section>`;
  }

  if (o.depth === 'rei') {
    if (o.units.length) {
      const best = o.units.reduce((a, b) => (b.avg >= a.avg ? b : a));
      const worst = o.units.reduce((a, b) => (b.avg <= a.avg ? b : a));
      body += `
      <section>
        <h2>Ficha por unidade (benefício Rei)</h2>
        ${o.units
          .slice(0, 8)
          .map(
            (u) => `
          <div class="unit">
            <h3>${esc(u.nome)}</h3>
            <div class="kpis">
              <div class="kpi"><em>Volume</em><strong>${u.total}</strong></div>
              <div class="kpi"><em>Média</em><strong>${u.avg.toFixed(1)}</strong></div>
              <div class="kpi"><em>Críticas</em><strong>${u.critical}</strong></div>
              <div class="kpi"><em>Positivas</em><strong>${u.positive}</strong></div>
            </div>
          </div>`
          )
          .join('')}
      </section>
      <section>
        <h2>Destaques executivos (benefício Rei)</h2>
        <ul class="exec">
          <li><b>Melhor média:</b> ${esc(best.nome)} (${best.avg.toFixed(1)})</li>
          <li><b>Ponto de atenção:</b> ${esc(worst.nome)} (${worst.avg.toFixed(1)})</li>
          <li><b>Críticas no ciclo:</b> ${o.critical}</li>
        </ul>
      </section>`;
    } else {
      body += `
      <section>
        <h2>Ficha por unidade + destaques (benefício Rei)</h2>
        <div class="empty">Quando houver filiais com avaliações, o Rei mostra ficha individual e destaques automático da rede.</div>
      </section>`;
    }
  }

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<title>${esc(p.label)} — ${esc(o.empresa)}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: Arial, Helvetica, sans-serif; color: #0f172a;
    font-size: 10pt; line-height: 1.45;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .banner {
    background: ${p.accent}; color: #fff; border-radius: 10px;
    padding: 14px 16px; margin-bottom: 14px;
  }
  .banner .plan { font-size: 22pt; font-weight: 800; letter-spacing: .06em; }
  .banner .tag { opacity: .95; font-size: 10pt; margin-top: 2px; }
  .banner .who { margin-top: 8px; font-size: 11pt; font-weight: 700; }
  .banner .meta { font-size: 8.5pt; opacity: .9; margin-top: 2px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
  .card {
    border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px 12px;
    background: ${p.soft};
  }
  .card h3 { margin: 0 0 6px; font-size: 9pt; text-transform: uppercase; letter-spacing: .04em; color: ${p.accent}; }
  .card ul { margin: 0; padding-left: 16px; font-size: 8.5pt; color: #334155; }
  h2 {
    font-size: 12pt; margin: 16px 0 8px; padding-bottom: 4px;
    border-bottom: 2px solid ${p.accent}; color: #0f172a;
  }
  h3 { font-size: 10.5pt; margin: 0 0 6px; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .kpis3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .kpi {
    border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px;
    background: #f8fafc;
  }
  .kpi em { display: block; font-style: normal; font-size: 7pt; text-transform: uppercase; color: #64748b; font-weight: 700; }
  .kpi strong { display: block; font-size: 18pt; margin-top: 4px; }
  .kpi small { color: #64748b; font-size: 8pt; }
  .kpi.ok strong { color: #15803d; }
  .kpi.warn strong { color: #b45309; }
  .kpi.bad strong { color: #b91c1c; }
  .bar { display: grid; grid-template-columns: 28px 1fr 28px; gap: 8px; align-items: center; margin: 6px 0; }
  .track { height: 11px; background: #e2e8f0; border-radius: 99px; overflow: hidden; }
  .track i { display: block; height: 100%; border-radius: 99px; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  th { text-align: left; background: ${p.accent}; color: #fff; padding: 7px 8px; }
  td { padding: 7px 8px; border-bottom: 1px solid #e2e8f0; }
  .unit { border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px; margin: 8px 0 12px; background: #fff; }
  .empty {
    border: 1px dashed #cbd5e1; border-radius: 10px; padding: 12px;
    background: #f8fafc; color: #64748b; font-size: 9pt;
  }
  .notice {
    background: ${p.soft}; border-left: 4px solid ${p.accent};
    padding: 10px 12px; border-radius: 0 8px 8px 0; margin-top: 12px;
  }
  .exec { margin: 0; padding-left: 18px; }
  .page-break { page-break-before: always; }
  footer {
    margin-top: 22px; text-align: center; font-size: 7.5pt; color: #94a3b8;
  }
  .preview {
    background: #fef2f2; color: #991b1b; font-size: 8pt; padding: 6px 10px;
    border-radius: 6px; margin-bottom: 10px; font-weight: 700;
  }
</style>
</head>
<body>
  ${o.preview ? `<div class="preview">PREVIEW ADMIN · layout forçado: ${esc(p.label)}</div>` : ''}

  <div class="banner">
    <div class="plan">PLANO ${esc(p.label)}</div>
    <div class="tag">${esc(p.tagline)}</div>
    <div class="who">${esc(o.empresa)}</div>
    <div class="meta">Ciclo ${esc(o.periodo)} · Conta: ${esc(o.planName)}</div>
  </div>

  <div class="grid2">
    <div class="card">
      <h3>Benefícios deste PDF</h3>
      <ul>${ben}</ul>
    </div>
    <div class="card">
      <h3>Não incluso neste plano</h3>
      <ul>${not}</ul>
    </div>
  </div>

  ${body}

  <footer>Filtra.AI · PDF ${esc(p.label)} · benefícios do plano · ciclo de assinatura</footer>
</body>
</html>`;
}

function chromiumPath(): string {
  return (
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROMIUM_PATH ||
    '/usr/bin/chromium'
  );
}

async function htmlToPdf(html: string): Promise<Buffer> {
  const browser = await puppeteer.launch({
    executablePath: chromiumPath(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45_000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', right: '11mm', bottom: '12mm', left: '11mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function ensureUnidadesSchema(db: Database): Promise<void> {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS unidades (
        id TEXT PRIMARY KEY,
        empresa_id TEXT NOT NULL,
        nome TEXT NOT NULL,
        slug TEXT,
        ativo INTEGER DEFAULT 1,
        criado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch {
    /* */
  }
}

export async function gerarRelatorioMensalPDF(
  db: Database,
  empresaId: string,
  mesAno: string,
  _unused?: unknown,
  _lang?: string | null,
  opts?: { forceDepth?: PdfDepth | null }
): Promise<{ buffer: Buffer; depth: PdfDepth; planLabel: string }> {
  const empresa = await db.get('SELECT * FROM empresas WHERE id = ?', [empresaId]);
  if (!empresa) throw new Error('Empresa não encontrada.');
  if (!empresaTemPdf(empresa)) throw new Error('Relatório PDF não disponível neste plano.');

  const plan = String(empresa.plan || empresa.status || 'trial').toLowerCase();
  const trial = isTrialPlan(plan) || isTrialPlan(String(empresa.status || ''));
  const depth = opts?.forceDepth || depthForPlan(plan, trial);
  const pLabel = trial && !opts?.forceDepth ? 'Trial' : planLabel(plan);

  const anchor = subscriptionAnchorDay(empresa as any);
  const range = cycleRangeForMonth(mesAno, anchor);
  const reviews = await loadReviews(db, empresaId, range);
  const unitsRaw = depth === 'corp' || depth === 'rei' ? await loadUnits(db, empresaId) : [];

  const total = reviews.length;
  const mean = avg(reviews);
  const positive = reviews.filter((r) => Number(r.rating) >= 4).length;
  const critical = reviews.filter((r) => Number(r.rating) <= 3).length;

  const units: UnitRow[] = unitsRaw
    .map((u) => {
      const list = reviews.filter(
        (r) =>
          String(r.unidade_id || '') === String(u.id) ||
          (u.slug && String(r.origin || '') === String(u.slug))
      );
      return {
        nome: String(u.nome || 'Unidade'),
        total: list.length,
        avg: avg(list),
        critical: list.filter((r) => Number(r.rating) <= 3).length,
        positive: list.filter((r) => Number(r.rating) >= 4).length,
      };
    })
    .filter((u) => u.total > 0)
    .sort((a, b) => b.avg - a.avg || b.total - a.total);

  const html = buildHtml({
    empresa: String(empresa.nome_empresa || 'Empresa'),
    planName: pLabel,
    depth,
    periodo: range.label,
    total,
    mean,
    positive,
    critical,
    dist: dist(reviews),
    sent: sentimentBreak(reviews),
    themes: themes(reviews),
    units,
    preview: Boolean(opts?.forceDepth),
  });

  const buffer = await htmlToPdf(html);
  if (buffer.length < 100 || buffer.subarray(0, 4).toString() !== '%PDF') {
    throw new Error('Puppeteer gerou PDF inválido.');
  }
  return { buffer, depth, planLabel: pLabel };
}
