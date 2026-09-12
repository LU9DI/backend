/** Filtra.AI PDF engine — plan-aware, multilingual and dynamically paginated. */
import type { Database } from 'sqlite';
import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import { empresaTemPdf, isTrialPlan, planLabel } from './lib/plans.js';

type Lang = 'pt-BR' | 'en-US' | 'es-ES' | 'zh-CN';
type Depth = 'pro' | 'ultra' | 'corp' | 'rei';
type Review = {
  rating: number;
  unidade_id?: string | null;
  createdAt?: string | Date;
  created_at?: string | Date;
  createdat?: string | Date;
  is_test?: number | boolean | null;
  ai_tags?: string | null;
  sentiment?: string | null;
};
type Unit = { id: string; nome: string; slug?: string | null };

const LANGS: Lang[] = ['pt-BR', 'en-US', 'es-ES', 'zh-CN'];
const C = {
  navy: '#0f172a', indigo: '#4f46e5', ink: '#1e293b', muted: '#64748b',
  line: '#e2e8f0', pale: '#f8fafc', white: '#ffffff', red: '#dc2626',
  green: '#16a34a', amber: '#d97706', orange: '#f97316', lime: '#84cc16',
  chart: ['#dc2626', '#f97316', '#eab308', '#84cc16', '#16a34a'],
};
const M = { left: 48, right: 48, top: 94, bottom: 48 };

const T: Record<Lang, Record<string, string>> = {
  'pt-BR': {
    subtitle: 'Relatório mensal de reputação', period: 'Período', plan: 'Plano', summary: 'Resumo executivo',
    volume: 'Avaliações válidas', avg: 'Nota média', positive: 'Positivas', critical: 'Críticas',
    distribution: 'Distribuição de notas', sentiment: 'Sentimento', pos: 'Positivo', neu: 'Neutro', neg: 'Negativo',
    themes: 'Principais temas', units: 'Desempenho por unidade', unit: 'Unidade', reviews: 'Avaliações',
    empty: 'Nenhuma avaliação válida foi registrada neste período.', noUnits: 'Não há unidades com avaliações no período.',
    page: 'Página', total: 'Total', periodTitle: 'Desempenho no período', stars: 'estrelas',
  },
  'en-US': {
    subtitle: 'Monthly reputation report', period: 'Period', plan: 'Plan', summary: 'Executive summary',
    volume: 'Valid reviews', avg: 'Average rating', positive: 'Positive', critical: 'Critical',
    distribution: 'Rating distribution', sentiment: 'Sentiment', pos: 'Positive', neu: 'Neutral', neg: 'Negative',
    themes: 'Top themes', units: 'Performance by unit', unit: 'Unit', reviews: 'Reviews',
    empty: 'No valid reviews were recorded for this period.', noUnits: 'There are no units with reviews in this period.',
    page: 'Page', total: 'Total', periodTitle: 'Performance in the period', stars: 'stars',
  },
  'es-ES': {
    subtitle: 'Informe mensual de reputación', period: 'Período', plan: 'Plan', summary: 'Resumen ejecutivo',
    volume: 'Reseñas válidas', avg: 'Calificación media', positive: 'Positivas', critical: 'Críticas',
    distribution: 'Distribución de calificaciones', sentiment: 'Sentimiento', pos: 'Positivo', neu: 'Neutral', neg: 'Negativo',
    themes: 'Temas principales', units: 'Rendimiento por unidad', unit: 'Unidad', reviews: 'Reseñas',
    empty: 'No se registraron reseñas válidas en este período.', noUnits: 'No hay unidades con reseñas en este período.',
    page: 'Página', total: 'Total', periodTitle: 'Rendimiento del período', stars: 'estrellas',
  },
  'zh-CN': {
    subtitle: '每月声誉报告', period: '期间', plan: '方案', summary: '执行摘要',
    volume: '有效评价', avg: '平均评分', positive: '正面', critical: '负面',
    distribution: '评分分布', sentiment: '情感', pos: '正面', neu: '中性', neg: '负面',
    themes: '主要主题', units: '各门店表现', unit: '门店', reviews: '评价',
    empty: '该期间没有有效评价记录。', noUnits: '该期间没有包含评价的门店。',
    page: '页', total: '总计', periodTitle: '期间表现', stars: '星',
  },
};

function langOf(value?: string | null): Lang {
  const s = String(value || 'pt-BR').trim();
  return LANGS.includes(s as Lang) ? s as Lang : 'pt-BR';
}
function tx(lang: Lang, key: string): string { return T[lang][key] || T['en-US'][key] || key; }
function pct(n: number, total: number): string { return total ? `${Math.round((n / total) * 100)}%` : '0%'; }
function isTest(r: Review): boolean { return Number(r.is_test) === 1 || r.is_test === true; }
function dateOf(r: Review): string | null {
  const d = r.createdAt ?? r.created_at ?? r.createdat;
  if (!d) return null;
  return typeof d === 'string' ? d : new Date(d).toISOString();
}
function inMonth(r: Review, month: string): boolean {
  const d = dateOf(r);
  return !d || d.slice(0, 7) === month;
}
function average(rows: Review[]): number { return rows.length ? rows.reduce((s, r) => s + Number(r.rating || 0), 0) / rows.length : 0; }
function distribution(rows: Review[]): number[] {
  const out = [0, 0, 0, 0, 0];
  for (const r of rows) { const n = Number(r.rating); if (n >= 1 && n <= 5) out[n - 1]++; }
  return out;
}
function sentiment(rows: Review[]) {
  let pos = 0, neu = 0, neg = 0;
  for (const r of rows) {
    const s = String(r.sentiment || '').toLowerCase();
    if (s.includes('pos')) pos++;
    else if (s.includes('neg')) neg++;
    else if (s.includes('neu')) neu++;
    else { const n = Number(r.rating); if (n >= 4) pos++; else if (n <= 2) neg++; else neu++; }
  }
  return { pos, neu, neg };
}
function themes(rows: Review[]): Array<[string, number]> {
  const map = new Map<string, number>();
  for (const r of rows) {
    if (!r.ai_tags) continue;
    try {
      const parsed = JSON.parse(String(r.ai_tags));
      if (Array.isArray(parsed)) for (const item of parsed) {
        const key = String(item || '').trim();
        if (key) map.set(key, (map.get(key) || 0) + 1);
      }
    } catch { /* ignore malformed optional AI metadata */ }
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
}
function depthForPlan(plan: string, trial: boolean): Depth {
  if (trial) return 'rei';
  const p = String(plan || '').toLowerCase();
  if (p === 'rei') return 'rei';
  if (p === 'corporativo' || p === 'corporate') return 'corp';
  if (p === 'ultra') return 'ultra';
  return 'pro';
}
function hasAi(depth: Depth): boolean { return depth === 'ultra' || depth === 'corp' || depth === 'rei'; }
function hasUnits(depth: Depth): boolean { return depth === 'corp' || depth === 'rei'; }

async function loadReviews(db: Database, empresaId: string, month: string): Promise<Review[]> {
  const queries = [
    'SELECT * FROM reviews WHERE empresa_id=?',
    'SELECT rating,is_test,created_at,unidade_id,ai_tags,sentiment FROM reviews WHERE empresa_id=?',
  ];
  for (const sql of queries) {
    try {
      const rows = await db.all(sql, [empresaId]) as Review[];
      return (rows || []).filter(r => !isTest(r) && inMonth(r, month));
    } catch { /* schema differences are handled by the fallback query */ }
  }
  return [];
}
async function loadUnits(db: Database, empresaId: string): Promise<Unit[]> {
  try {
    const rows = await db.all('SELECT id,nome,slug FROM unidades WHERE empresa_id=? AND ativo=1 ORDER BY nome', [empresaId]) as any[];
    return (rows || []).map(u => ({ id: String(u.id), nome: String(u.nome || 'Unidade'), slug: u.slug ? String(u.slug) : null }));
  } catch { return []; }
}
export async function ensureUnidadesSchema(_db: Database): Promise<void> { return; }

function width(doc: PDFKit.PDFDocument): number { return doc.page.width - M.left - M.right; }
function header(doc: PDFKit.PDFDocument, plan: string, period: string, depth: Depth): void {
  doc.rect(0, 0, doc.page.width, 72).fill(C.navy);
  doc.rect(0, 72, doc.page.width, 3).fill(C.indigo);
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(15).text('Filtra.AI', M.left, 18, { lineBreak: false });
  doc.fillColor('#a5b4fc').font('Helvetica').fontSize(8).text(plan, M.left, 42, { lineBreak: false });
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(8).text(depth.toUpperCase(), doc.page.width - 160, 18, { width: 112, align: 'right', lineBreak: false });
  doc.fillColor('#cbd5e1').font('Helvetica').fontSize(8).text(period, doc.page.width - 160, 38, { width: 112, align: 'right', lineBreak: false });
  doc.y = M.top;
}
function footer(doc: PDFKit.PDFDocument, lang: Lang): void {
  const y = doc.page.height - 30;
  doc.strokeColor(C.line).lineWidth(.6).moveTo(M.left, y - 5).lineTo(doc.page.width - M.right, y - 5).stroke();
  doc.fillColor(C.muted).font('Helvetica').fontSize(7).text('Filtra.AI', M.left, y, { lineBreak: false });
  doc.text(`${tx(lang, 'page')} ${doc.page.number}`, doc.page.width - M.right - 100, y, { width: 100, align: 'right', lineBreak: false });
}
function sectionTitle(doc: PDFKit.PDFDocument, text: string): void {
  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(12).text(text, { width: width(doc), lineBreak: false });
  doc.moveDown(.45);
}
function ensureRoom(doc: PDFKit.PDFDocument, needed: number, plan: string, period: string, depth: Depth): void {
  if (doc.y + needed > doc.page.height - M.bottom) { doc.addPage(); header(doc, plan, period, depth); }
}
function cards(doc: PDFKit.PDFDocument, items: Array<{ label: string; value: string; sub: string; accent: string }>): void {
  const gap = 8, W = width(doc), bw = (W - gap * 3) / 4, y = doc.y;
  items.forEach((item, i) => {
    const x = M.left + i * (bw + gap);
    doc.roundedRect(x, y, bw, 70, 6).fillAndStroke(C.pale, C.line);
    doc.rect(x, y, 3, 70).fill(item.accent);
    doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(6.5).text(item.label.toUpperCase(), x + 9, y + 9, { width: bw - 15, lineBreak: false });
    doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(18).text(item.value, x + 9, y + 25, { width: bw - 15, lineBreak: false });
    doc.fillColor(C.muted).font('Helvetica').fontSize(7).text(item.sub, x + 9, y + 49, { width: bw - 15, lineBreak: false });
  });
  doc.y = y + 84;
}
function distributionChart(doc: PDFKit.PDFDocument, values: number[], lang: Lang): void {
  const y = doc.y, W = width(doc), h = 154, gap = 12, bw = (W - gap * 6) / 5, max = Math.max(...values, 1), usable = 88;
  doc.roundedRect(M.left, y, W, h, 6).fillAndStroke(C.white, C.line);
  values.forEach((v, i) => {
    const bh = Math.max(2, (v / max) * usable), x = M.left + gap + i * (bw + gap), base = y + 118;
    doc.roundedRect(x, base - bh, bw, bh, 3).fill(C.chart[i]);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9).text(String(v), x, base - bh - 14, { width: bw, align: 'center', lineBreak: false });
    doc.fillColor(C.muted).font('Helvetica').fontSize(8).text(`${i + 1} ${tx(lang, 'stars')}`, x, base + 9, { width: bw, align: 'center', lineBreak: false });
  });
  doc.y = y + h + 12;
}
function sentimentBox(doc: PDFKit.PDFDocument, rows: Review[], lang: Lang): void {
  const s = sentiment(rows), total = rows.length, y = doc.y, W = width(doc), h = 76, gap = 8, bw = (W - gap * 2) / 3;
  [['pos', s.pos, C.green], ['neu', s.neu, C.amber], ['neg', s.neg, C.red]].forEach(([k, n, accent], i) => {
    const x = M.left + i * (bw + gap);
    doc.roundedRect(x, y, bw, h, 6).fillAndStroke(C.pale, C.line);
    doc.rect(x, y, 3, h).fill(accent as string);
    doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8).text(tx(lang, k as string), x + 10, y + 11, { width: bw - 18, lineBreak: false });
    doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(16).text(`${n} (${pct(n as number, total)})`, x + 10, y + 32, { width: bw - 18, lineBreak: false });
  });
  doc.y = y + h + 12;
}
function themesBox(doc: PDFKit.PDFDocument, rows: Review[], lang: Lang): void {
  const data = themes(rows);
  if (!data.length) return;
  const y = doc.y, W = width(doc), rowH = 22, h = 34 + data.length * rowH;
  ensureRoom(doc, h + 12, '', '', 'pro');
  doc.roundedRect(M.left, doc.y, W, h, 6).fillAndStroke(C.white, C.line);
  doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(7).text(tx(lang, 'themes').toUpperCase(), M.left + 12, doc.y + 10);
  data.forEach(([name, count], i) => {
    const yy = doc.y + 32 + i * rowH;
    doc.fillColor(C.ink).font('Helvetica').fontSize(8).text(name, M.left + 12, yy, { width: W - 70, lineBreak: false });
    doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8).text(String(count), M.left + W - 45, yy, { width: 30, align: 'right', lineBreak: false });
  });
  doc.y += h + 12;
}
function unitStats(units: Unit[], rows: Review[]) {
  const map = new Map<string, { total: number; avg: number; critical: number }>();
  for (const u of units) map.set(u.id, { total: 0, avg: 0, critical: 0 });
  for (const r of rows) {
    const id = String(r.unidade_id || '');
    const s = map.get(id); if (!s) continue;
    s.total++; s.avg += Number(r.rating || 0); if (Number(r.rating) <= 3) s.critical++;
  }
  return units.map(u => { const s = map.get(u.id)!; return { ...u, total: s.total, avg: s.total ? s.avg / s.total : 0, critical: s.critical }; }).filter(u => u.total > 0).sort((a, b) => b.avg - a.avg || b.total - a.total);
}
function unitsTable(doc: PDFKit.PDFDocument, units: Unit[], rows: Review[], lang: Lang, plan: string, period: string, depth: Depth): void {
  const stats = unitStats(units, rows);
  if (!stats.length) return;
  ensureRoom(doc, 72, plan, period, depth);
  sectionTitle(doc, tx(lang, 'units'));
  const W = width(doc), cols = [W * .48, W * .17, W * .17, W * .18], x = M.left, rowH = 28;
  doc.roundedRect(x, doc.y, W, rowH, 4).fill(C.pale);
  let cx = x;
  [tx(lang, 'unit'), tx(lang, 'reviews'), tx(lang, 'avg'), tx(lang, 'critical')].forEach((label, i) => { doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(7).text(label.toUpperCase(), cx + 8, doc.y + 10, { width: cols[i] - 12, lineBreak: false }); cx += cols[i]; });
  doc.y += rowH;
  stats.forEach((s, index) => {
    ensureRoom(doc, rowH + 4, plan, period, depth);
    if (index % 2 === 0) doc.rect(x, doc.y, W, rowH).fill('#fbfdff');
    let px = x;
    const values = [s.nome, String(s.total), s.avg.toFixed(2), String(s.critical)];
    values.forEach((v, i) => { doc.fillColor(C.ink).font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).text(v, px + 8, doc.y + 9, { width: cols[i] - 12, lineBreak: false }); px += cols[i]; });
    doc.y += rowH;
  });
  doc.moveDown(.6);
}

export async function gerarRelatorioMensalPDF(
  db: Database,
  empresaId: string,
  mesAno: string,
  _callGroq?: Function,
  idioma: string = 'pt-BR',
): Promise<Buffer> {
  const empresa: any = await db.get('SELECT * FROM empresas WHERE id=?', [empresaId]);
  if (!empresa) throw new Error('Empresa não encontrada.');

  const plan = String(empresa.plan || empresa.status || '').trim().toLowerCase();
  const trial = isTrialPlan(plan) || isTrialPlan(String(empresa.status || ''));
  if (!empresaTemPdf(empresa) && !trial) throw new Error('Plano não elegível para relatório mensal.');

  const lang = langOf(idioma || empresa.locale || empresa.idioma || empresa.language);
  const depth = depthForPlan(plan, trial);
  const planText = planLabel(trial ? 'trial' : plan);
  const reviews = await loadReviews(db, empresaId, mesAno);
  const total = reviews.length;
  const avg = average(reviews);
  const dist = distribution(reviews);
  const positive = reviews.filter(r => Number(r.rating) >= 4).length;
  const critical = reviews.filter(r => Number(r.rating) <= 3).length;
  const units = hasUnits(depth) ? await loadUnits(db, empresaId) : [];
  const periodText = mesAno;

  const fontPath = String(process.env.PDF_FONT_PATH || '').trim();
  const fontAvailable = fontPath && fs.existsSync(fontPath);
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, compress: true });
  if (fontAvailable) { try { doc.registerFont('FiltraSans', fontPath); } catch { /* fallback to Helvetica */ } }
  const bodyFont = fontAvailable ? 'FiltraSans' : 'Helvetica';
  const bodyBold = fontAvailable ? 'FiltraSans' : 'Helvetica-Bold';
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  // Page 1 is always meaningful: identity + period + executive metrics.
  header(doc, planText, periodText, depth);
  doc.fillColor(C.navy).font(bodyBold).fontSize(19).text(String(empresa.nome_empresa || 'Empresa'));
  doc.moveDown(.25);
  doc.fillColor(C.muted).font(bodyFont).fontSize(9).text(`${tx(lang, 'period')}: ${periodText}  |  ${tx(lang, 'plan')}: ${planText}`);
  doc.moveDown(1.1);
  sectionTitle(doc, tx(lang, 'summary'));
  cards(doc, [
    { label: tx(lang, 'volume'), value: String(total), sub: tx(lang, 'total'), accent: C.indigo },
    { label: tx(lang, 'avg'), value: avg ? avg.toFixed(2) : '-', sub: '1–5', accent: C.indigo },
    { label: tx(lang, 'positive'), value: String(positive), sub: pct(positive, total), accent: C.green },
    { label: tx(lang, 'critical'), value: String(critical), sub: pct(critical, total), accent: C.red },
  ]);

  sectionTitle(doc, tx(lang, 'distribution'));
  distributionChart(doc, dist, lang);

  if (!total) {
    doc.fillColor(C.muted).font(bodyFont).fontSize(9).text(tx(lang, 'empty'), { width: width(doc) });
  } else {
    // AI-related sections exist only for plans that actually offer AI.
    if (hasAi(depth)) {
      ensureRoom(doc, 110, planText, periodText, depth);
      sectionTitle(doc, tx(lang, 'sentiment'));
      sentimentBox(doc, reviews, lang);
      if (themes(reviews).length) {
        const h = 34 + themes(reviews).length * 22;
        ensureRoom(doc, h + 12, planText, periodText, depth);
        const data = themes(reviews), y = doc.y, W = width(doc);
        doc.roundedRect(M.left, y, W, h, 6).fillAndStroke(C.white, C.line);
        doc.fillColor(C.muted).font(bodyBold).fontSize(7).text(tx(lang, 'themes').toUpperCase(), M.left + 12, y + 10);
        data.forEach(([name, count], i) => {
          const yy = y + 32 + i * 22;
          doc.fillColor(C.ink).font(bodyFont).fontSize(8).text(name, M.left + 12, yy, { width: W - 70, lineBreak: false });
          doc.fillColor(C.muted).font(bodyBold).fontSize(8).text(String(count), M.left + W - 45, yy, { width: 30, align: 'right', lineBreak: false });
        });
        doc.y = y + h + 12;
      }
    }

    // Corporate/Rei/Trial: units are a real benefit, so only render the section when data exists.
    if (hasUnits(depth) && units.length) {
      unitsTable(doc, units, reviews, lang, planText, periodText, depth);
    }
  }

  // No reserved/placeholder pages: pages are created only by ensureRoom/addPage above.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) { doc.switchToPage(range.start + i); footer(doc, lang); }

  const finished = new Promise<void>((resolve, reject) => { doc.once('end', resolve); doc.once('error', reject); });
  doc.end();
  await finished;
  const output = Buffer.concat(chunks);
  if (output.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('PDF gerado inválido.');
  return output;
}
