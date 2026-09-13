/**
 * Relatório PDF mensal — Puppeteer (Chromium) + HTML por plano.
 * Período = ciclo de assinatura (dia âncora), não dia 1 do mês civil.
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

const THEME: Record<
  PdfDepth,
  { accent: string; title: string; includes: string[]; locked: string[] }
> = {
  pro: {
    accent: '#4f46e5',
    title: 'Relatório Pro',
    includes: ['Resumo do ciclo', 'Distribuição 1★–5★'],
    locked: ['Sentimento e temas IA → Ultra+', 'Ranking de filiais → Corporativo+'],
  },
  ultra: {
    accent: '#0d9488',
    title: 'Relatório Ultra',
    includes: ['Tudo do Pro', 'Sentimento', 'Temas da IA'],
    locked: ['Ranking de filiais → Corporativo+', 'Ficha por unidade → Rei'],
  },
  corp: {
    accent: '#1d4ed8',
    title: 'Relatório Corporativo',
    includes: ['Tudo do Ultra', 'Ranking de unidades'],
    locked: ['Ficha detalhada por unidade → Rei'],
  },
  rei: {
    accent: '#b45309',
    title: 'Relatório Rei',
    includes: ['Tudo do Corporativo', 'Ficha por unidade', 'Destaques do ciclo'],
    locked: [],
  },
};

function depthFor(plan: string, trial: boolean): PdfDepth {
  if (trial) return 'ultra';
  const p = plan.toLowerCase();
  if (p === 'rei') return 'rei';
  if (p === 'corporativo' || p === 'corporate') return 'corp';
  if (p === 'ultra') return 'ultra';
  return 'pro';
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
      /* ignore */
    }
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag, count]) => ({ tag, count }));
}

function insight(total: number, mean: number, critical: number, positive: number) {
  if (!total) return 'Ainda não há avaliações neste ciclo. O relatório preenche sozinho.';
  if (mean >= 4.5) return `Ciclo forte: média ${mean.toFixed(1)} com ${pct(positive, total)}% positivas.`;
  if (mean >= 4) return `Bom ciclo (média ${mean.toFixed(1)}). Dá para reduzir as ${critical} críticas.`;
  if (mean >= 3) return `Ciclo estável (média ${mean.toFixed(1)}). Priorize as ${critical} críticas.`;
  return `Atenção: média ${mean.toFixed(1)} e ${critical} críticas neste ciclo.`;
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
      /* next */
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

function buildHtml(opts: {
  empresa: string;
  planLabel: string;
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
}): string {
  const t = THEME[opts.depth];
  const maxBar = Math.max(...opts.dist, 1);
  const bars = opts.dist
    .map((n, i) => {
      const colors = ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'];
      const w = Math.round((n / maxBar) * 100);
      return `<div class="bar-row"><span>${i + 1}★</span><div class="track"><i style="width:${w}%;background:${colors[i]}"></i></div><b>${n}</b></div>`;
    })
    .join('');

  const includes = t.includes.map((x) => `<li>${esc(x)}</li>`).join('');
  const locked = t.locked.length
    ? t.locked.map((x) => `<li>${esc(x)}</li>`).join('')
    : '<li>Relatório completo deste plano</li>';

  let extra = '';

  if (opts.depth !== 'pro') {
    extra += `
    <section>
      <h2>3. Sentimento</h2>
      <div class="cards3">
        <div class="card"><span class="ok">Positivo</span><strong>${opts.sent.pos}</strong><small>${pct(opts.sent.pos, opts.total)}%</small></div>
        <div class="card"><span class="warn">Neutro</span><strong>${opts.sent.neu}</strong><small>${pct(opts.sent.neu, opts.total)}%</small></div>
        <div class="card"><span class="bad">Negativo</span><strong>${opts.sent.neg}</strong><small>${pct(opts.sent.neg, opts.total)}%</small></div>
      </div>
    </section>
    <section>
      <h2>4. Temas da IA</h2>
      ${
        opts.themes.length
          ? `<table><thead><tr><th>Tema</th><th>Qtd</th></tr></thead><tbody>${opts.themes
              .map((x) => `<tr><td>${esc(x.tag)}</td><td>${x.count}</td></tr>`)
              .join('')}</tbody></table>`
          : `<p class="muted">Nenhum tema neste ciclo.</p>`
      }
    </section>`;
  } else {
    extra += `
    <section>
      <h2>3. Análise avançada</h2>
      <p>No <b>Pro</b> você vê volume, nota e distribuição. Sentimento, temas e filiais entram em <b>Ultra</b>, <b>Corporativo</b> e <b>Rei</b>.</p>
    </section>`;
  }

  if (opts.depth === 'corp' || opts.depth === 'rei') {
    extra += `
    <section class="break">
      <h2>5. Ranking de unidades</h2>
      ${
        opts.units.length
          ? `<table><thead><tr><th>#</th><th>Unidade</th><th>Volume</th><th>Média</th><th>Críticas</th></tr></thead><tbody>${opts.units
              .map(
                (u, i) =>
                  `<tr><td>${i + 1}</td><td>${esc(u.nome)}</td><td>${u.total}</td><td><b>${u.avg.toFixed(1)}</b></td><td>${u.critical}</td></tr>`
              )
              .join('')}</tbody></table>`
          : `<p class="muted">Nenhuma unidade com avaliações neste ciclo.</p>`
      }
    </section>`;
  }

  if (opts.depth === 'rei' && opts.units.length) {
    const best = opts.units.reduce((a, b) => (b.avg > a.avg ? b : a));
    const worst = opts.units.reduce((a, b) => (b.avg < a.avg ? b : a));
    extra += `
    <section>
      <h2>6. Ficha por unidade</h2>
      ${opts.units
        .slice(0, 8)
        .map(
          (u) => `
        <div class="unit">
          <h3>${esc(u.nome)}</h3>
          <div class="cards4">
            <div class="card"><span>Volume</span><strong>${u.total}</strong></div>
            <div class="card"><span>Média</span><strong>${u.avg.toFixed(1)}</strong></div>
            <div class="card"><span>Críticas</span><strong>${u.critical}</strong></div>
            <div class="card"><span>Positivas</span><strong>${u.positive}</strong></div>
          </div>
        </div>`
        )
        .join('')}
    </section>
    <section>
      <h2>7. Destaques</h2>
      <ul>
        <li>Melhor média: <b>${esc(best.nome)}</b> (${best.avg.toFixed(1)})</li>
        <li>Atenção: <b>${esc(worst.nome)}</b> (${worst.avg.toFixed(1)})</li>
        <li>Críticas no ciclo: <b>${opts.critical}</b></li>
      </ul>
    </section>`;
  }

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<title>${esc(t.title)} — ${esc(opts.empresa)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #0f172a; font-size: 10pt; line-height: 1.45; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .accent { color: ${t.accent}; }
  .bar { height: 4px; width: 48px; background: ${t.accent}; margin: 8px 0 14px; border-radius: 2px; }
  h1 { font-size: 18pt; margin: 0 0 4px; }
  h2 { font-size: 12pt; margin: 18px 0 8px; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
  h3 { font-size: 10.5pt; margin: 0 0 6px; }
  .brand { font-size: 9pt; color: #64748b; font-weight: 700; letter-spacing: .04em; }
  .plan { font-size: 16pt; font-weight: 800; color: ${t.accent}; margin: 2px 0; }
  .meta { color: #64748b; font-size: 9pt; margin-bottom: 10px; }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0 14px; }
  .box { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; }
  .box.ok { background: #f0fdf4; border-color: #bbf7d0; }
  .box.muted { background: #f8fafc; }
  .box b { display: block; margin-bottom: 4px; font-size: 8.5pt; }
  .box ul { margin: 0; padding-left: 16px; font-size: 8.5pt; color: #334155; }
  .insight { background: #f8fafc; border-left: 3px solid ${t.accent}; padding: 8px 12px; margin: 8px 0 14px; font-size: 9.5pt; }
  .cards4, .cards3 { display: grid; gap: 8px; }
  .cards4 { grid-template-columns: repeat(4, 1fr); }
  .cards3 { grid-template-columns: repeat(3, 1fr); }
  .card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; background: #f8fafc; }
  .card span { display: block; font-size: 7pt; text-transform: uppercase; color: #64748b; font-weight: 700; }
  .card strong { display: block; font-size: 16pt; margin-top: 4px; }
  .card small { color: #64748b; font-size: 8pt; }
  .ok { color: #15803d !important; }
  .warn { color: #b45309 !important; }
  .bad { color: #b91c1c !important; }
  .bar-row { display: grid; grid-template-columns: 28px 1fr 28px; gap: 8px; align-items: center; margin: 6px 0; font-size: 9pt; }
  .track { height: 10px; background: #eef2f7; border-radius: 99px; overflow: hidden; }
  .track i { display: block; height: 100%; border-radius: 99px; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  th { text-align: left; background: ${t.accent}; color: #fff; padding: 7px 8px; }
  td { padding: 7px 8px; border-bottom: 1px solid #e2e8f0; }
  .unit { margin: 10px 0 14px; padding: 10px; border: 1px solid #e2e8f0; border-radius: 8px; }
  .muted { color: #64748b; }
  .break { page-break-before: always; }
  footer { margin-top: 20px; font-size: 7.5pt; color: #94a3b8; text-align: center; }
</style>
</head>
<body>
  <div class="brand">FILTRA.AI</div>
  <div class="plan">${esc(t.title)}</div>
  <h1>${esc(opts.empresa)}</h1>
  <div class="meta">Ciclo · ${esc(opts.periodo)} &nbsp;|&nbsp; Plano <b>${esc(opts.planLabel)}</b></div>
  <div class="bar"></div>

  <div class="split">
    <div class="box ok"><b>Inclui neste plano</b><ul>${includes}</ul></div>
    <div class="box muted"><b>Só em planos superiores</b><ul>${locked}</ul></div>
  </div>

  <div class="insight"><b>Leitura rápida:</b> ${esc(insight(opts.total, opts.mean, opts.critical, opts.positive))}</div>

  <section>
    <h2>1. Resumo do ciclo</h2>
    <div class="cards4">
      <div class="card"><span>Volume</span><strong>${opts.total}</strong><small>avaliações</small></div>
      <div class="card"><span>Nota média</span><strong>${opts.total ? opts.mean.toFixed(1) : '—'}</strong><small>1 a 5</small></div>
      <div class="card"><span>Positivas</span><strong>${opts.positive}</strong><small>${pct(opts.positive, opts.total)}%</small></div>
      <div class="card"><span>Críticas</span><strong>${opts.critical}</strong><small>${pct(opts.critical, opts.total)}%</small></div>
    </div>
  </section>

  <section>
    <h2>2. Distribuição de notas</h2>
    ${bars}
  </section>

  ${extra}

  <footer>Filtra.AI · ${esc(t.title)} · ciclo de assinatura · sem projeção futura</footer>
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
      margin: { top: '14mm', right: '12mm', bottom: '14mm', left: '12mm' },
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
    /* ok */
  }
}

export async function gerarRelatorioMensalPDF(
  db: Database,
  empresaId: string,
  mesAno: string,
  _unused?: unknown,
  _lang?: string | null
): Promise<Buffer> {
  const empresa = await db.get('SELECT * FROM empresas WHERE id = ?', [empresaId]);
  if (!empresa) throw new Error('Empresa não encontrada.');
  if (!empresaTemPdf(empresa)) throw new Error('Relatório PDF não disponível neste plano.');

  const plan = String(empresa.plan || empresa.status || 'trial').toLowerCase();
  const trial = isTrialPlan(plan) || isTrialPlan(String(empresa.status || ''));
  const depth = depthFor(plan, trial);
  const anchor = subscriptionAnchorDay(empresa as any);
  const range = cycleRangeForMonth(mesAno, anchor);

  const reviews = await loadReviews(db, empresaId, range);
  const unitsRaw = depth === 'corp' || depth === 'rei' ? await loadUnits(db, empresaId) : [];

  const total = reviews.length;
  const mean = avg(reviews);
  const positive = reviews.filter((r) => Number(r.rating) >= 4).length;
  const critical = reviews.filter((r) => Number(r.rating) <= 3).length;
  const se = sentimentBreak(reviews);
  const th = themes(reviews);

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
    planLabel: trial ? 'Trial' : planLabel(plan),
    depth,
    periodo: range.label,
    total,
    mean,
    positive,
    critical,
    dist: dist(reviews),
    sent: se,
    themes: th,
    units,
  });

  const pdf = await htmlToPdf(html);
  if (pdf.length < 100 || pdf.subarray(0, 4).toString() !== '%PDF') {
    throw new Error('Puppeteer gerou PDF inválido.');
  }
  return pdf;
}
