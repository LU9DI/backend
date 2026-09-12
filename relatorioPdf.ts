/**
 * Relatorio mensal PDF — conteudo e beneficios DIFERENTES por plano.
 *
 * Pro:   KPIs + barras 1*-5* + positivas vs criticas
 * Ultra: + sentimento + temas IA
 * Corp:  + ranking unidades + pagina por filial
 * Rei:   + donut + gargalos + pagina rica por filial
 * Trial: = Ultra
 *
 * Layout v5 — checklist de beneficios visivel + secoes por depth.
 */
import type { Database } from 'sqlite';
import PDFDocument from 'pdfkit';
import { empresaTemPdf, isTrialPlan, planLabel } from './lib/plans.js';
import {
  normalizePdfLang,
  monthPeriod,
  t,
  benefitsFor,
  badgeFor,
  featureChecklist,
  type PdfLang,
} from './lib/pdfI18n.js';

type ReviewRow = {
  rating: number;
  unidade_id?: string | null;
  origin?: string | null;
  createdAt?: string;
  createdat?: string;
  created_at?: string;
  is_test?: number | boolean | null;
  ai_tags?: string | null;
  sentiment?: string | null;
};

type Unidade = { id: string; nome: string; slug?: string | null };
export type PdfDepth = 'pro' | 'ultra' | 'corp' | 'rei';
export const PDF_LAYOUT_VERSION = 'v5';

const C = {
  navy: '#0f172a',
  indigo: '#4f46e5',
  indigoLt: '#818cf8',
  ink: '#1e293b',
  muted: '#64748b',
  line: '#e2e8f0',
  pale: '#f1f5f9',
  white: '#ffffff',
  red: '#dc2626',
  green: '#16a34a',
  amber: '#d97706',
  locked: '#94a3b8',
  star: ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'] as string[],
};

const M = { left: 48, right: 48, bottom: 48 };

export async function ensureUnidadesSchema(db: Database): Promise<void> {
  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS unidades (
      id TEXT PRIMARY KEY, empresa_id TEXT NOT NULL, nome TEXT NOT NULL,
      slug TEXT, ativo INTEGER DEFAULT 1,
      criado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
  } catch (e: any) {
    console.warn('[pdf] unidades:', e?.message || e);
  }
  for (const col of ['unidade_id TEXT', 'origin TEXT']) {
    try {
      await db.exec(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS ${col}`);
    } catch {
      try {
        await db.exec(`ALTER TABLE reviews ADD COLUMN ${col}`);
      } catch {
        /* */
      }
    }
  }
}

export function depthForPlan(plan: string, trial: boolean): PdfDepth {
  if (trial) return 'ultra';
  const p = String(plan || '').toLowerCase();
  if (p === 'rei') return 'rei';
  if (p === 'corporativo') return 'corp';
  if (p === 'ultra') return 'ultra';
  return 'pro';
}

function isTest(r: ReviewRow): boolean {
  return Number(r.is_test) === 1 || r.is_test === true;
}
function rowDate(r: ReviewRow): string {
  return String(r.createdAt || r.createdat || r.created_at || '');
}
function media(reviews: ReviewRow[]): number {
  if (!reviews.length) return 0;
  return reviews.reduce((s, r) => s + Number(r.rating || 0), 0) / reviews.length;
}
function pct(v: number, tot: number): string {
  return tot ? `${Math.round((v / tot) * 100)}%` : '0%';
}
function parseTags(reviews: ReviewRow[]): { tag: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const r of reviews) {
    if (!r.ai_tags) continue;
    try {
      const parsed = JSON.parse(String(r.ai_tags));
      if (!Array.isArray(parsed)) continue;
      for (const tag of parsed) {
        const key = String(tag).trim().slice(0, 40);
        if (key) counts[key] = (counts[key] || 0) + 1;
      }
    } catch {
      /* */
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag, count]) => ({ tag, count }));
}
function sentimentOf(reviews: ReviewRow[]) {
  let pos = 0,
    neu = 0,
    neg = 0;
  for (const r of reviews) {
    const s = String(r.sentiment || '').toLowerCase();
    if (s.includes('pos')) pos++;
    else if (s.includes('neg')) neg++;
    else if (s) neu++;
    else {
      const n = Number(r.rating);
      if (n >= 4) pos++;
      else if (n <= 2) neg++;
      else neu++;
    }
  }
  return { pos, neu, neg };
}

async function loadReviews(db: Database, empresaId: string, mesAno: string): Promise<ReviewRow[]> {
  const sqls = [
    `SELECT rating, is_test, ai_tags, sentiment, unidade_id, origin, created_at FROM reviews WHERE empresa_id = ? LIMIT 3000`,
    `SELECT rating, is_test, ai_tags, sentiment, unidade_id, origin FROM reviews WHERE empresa_id = ? LIMIT 3000`,
  ];
  let rows: any[] = [];
  for (const sql of sqls) {
    try {
      rows = (await db.all(sql, [empresaId])) as any[];
      break;
    } catch {
      rows = [];
    }
  }
  const out: ReviewRow[] = [];
  for (const r of rows) {
    if (isTest(r as ReviewRow)) continue;
    const d = rowDate(r as ReviewRow);
    if (d && !d.startsWith(mesAno)) continue;
    out.push(r as ReviewRow);
  }
  return out;
}

async function loadUnidades(db: Database, empresaId: string): Promise<Unidade[]> {
  try {
    const rows = (await db.all(
      `SELECT id, nome, slug FROM unidades WHERE empresa_id = ? ORDER BY nome ASC`,
      [empresaId]
    )) as any[];
    return (rows || []).map((u) => ({
      id: String(u.id),
      nome: String(u.nome || 'Filial'),
      slug: u.slug ? String(u.slug) : null,
    }));
  } catch {
    return [];
  }
}

function contentWidth(doc: PDFKit.PDFDocument) {
  return doc.page.width - M.left - M.right;
}

function header(
  doc: PDFKit.PDFDocument,
  plan: string,
  periodo: string,
  depth: PdfDepth,
  lang: PdfLang = 'pt'
) {
  const w = doc.page.width;
  doc.rect(0, 0, w, 68).fill(C.navy);
  doc.rect(0, 68, w, 3).fill(C.indigo);
  doc
    .fillColor(C.white)
    .font('Helvetica-Bold')
    .fontSize(15)
    .text('Filtra.AI', M.left, 18, { lineBreak: false });
  doc
    .fillColor(C.indigoLt)
    .font('Helvetica')
    .fontSize(8)
    .text(t(lang, 'subtitle'), M.left, 40, { lineBreak: false });
  doc
    .fillColor(C.white)
    .font('Helvetica-Bold')
    .fontSize(9)
    .text(plan.toUpperCase(), w - 160, 16, { width: 112, align: 'right', lineBreak: false });
  doc
    .fillColor('#94a3b8')
    .font('Helvetica')
    .fontSize(8)
    .text(periodo, w - 160, 32, { width: 112, align: 'right', lineBreak: false });
  doc
    .fillColor('#a5b4fc')
    .font('Helvetica-Bold')
    .fontSize(7)
    .text(badgeFor(depth, lang), w - 160, 46, { width: 112, align: 'right', lineBreak: false });
  doc.x = M.left;
  doc.y = 88;
}

function footer(
  doc: PDFKit.PDFDocument,
  emissao: string,
  page: number,
  total: number,
  lang: PdfLang = 'pt'
) {
  const y = doc.page.height - 32;
  doc
    .strokeColor(C.line)
    .lineWidth(0.6)
    .moveTo(M.left, y - 6)
    .lineTo(doc.page.width - M.right, y - 6)
    .stroke();
  doc
    .fillColor(C.muted)
    .font('Helvetica')
    .fontSize(7)
    .text(`Filtra.AI | ${emissao}`, M.left, y, { lineBreak: false });
  doc
    .fillColor(C.muted)
    .font('Helvetica')
    .fontSize(7)
    .text(t(lang, 'page', { n: page, t: total }), doc.page.width - M.right - 100, y, {
      width: 100,
      align: 'right',
      lineBreak: false,
    });
}

function title(doc: PDFKit.PDFDocument, text: string) {
  doc.x = M.left;
  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(11).text(text, M.left, doc.y, {
    width: contentWidth(doc),
  });
  doc.moveDown(0.35);
}

/** Caixa de beneficios do plano — incluido [x] vs superior [ ]. */
function drawBenefitsBox(doc: PDFKit.PDFDocument, depth: PdfDepth, lang: PdfLang) {
  const items = featureChecklist(depth, lang);
  const w = contentWidth(doc);
  const lineH = 14;
  const pad = 10;
  const headerH = 22;
  const h = headerH + pad + items.length * lineH + pad;
  const y0 = doc.y;

  doc.roundedRect(M.left, y0, w, h, 6).fillAndStroke(C.pale, C.line);
  doc
    .fillColor(C.indigo)
    .font('Helvetica-Bold')
    .fontSize(9)
    .text(t(lang, 'benefits_title'), M.left + pad, y0 + 8, {
      width: w - pad * 2,
      lineBreak: false,
    });

  let y = y0 + headerH + 4;
  for (const it of items) {
    const mark = it.included ? '[x]' : '[ ]';
    const color = it.included ? C.green : C.locked;
    doc
      .fillColor(color)
      .font('Helvetica-Bold')
      .fontSize(8)
      .text(mark, M.left + pad, y, { lineBreak: false });
    doc
      .fillColor(it.included ? C.ink : C.locked)
      .font('Helvetica')
      .fontSize(8)
      .text(it.label, M.left + pad + 28, y, { width: w - pad * 2 - 28, lineBreak: false });
    y += lineH;
  }
  doc.x = M.left;
  doc.y = y0 + h + 12;
}

function kpis(
  doc: PDFKit.PDFDocument,
  items: { label: string; value: string; sub: string; color?: string }[]
) {
  const w = contentWidth(doc);
  const gap = 8;
  const n = items.length;
  const boxW = (w - gap * (n - 1)) / n;
  const y = doc.y;
  items.forEach((it, i) => {
    const x = M.left + i * (boxW + gap);
    doc.roundedRect(x, y, boxW, 70, 6).fillAndStroke(C.pale, C.line);
    doc.rect(x, y, 3.5, 70).fill(it.color || C.indigo);
    doc
      .fillColor(C.indigo)
      .font('Helvetica-Bold')
      .fontSize(6.5)
      .text(it.label.toUpperCase(), x + 10, y + 10, { width: boxW - 16, lineBreak: false });
    doc
      .fillColor(C.navy)
      .font('Helvetica-Bold')
      .fontSize(18)
      .text(it.value, x + 10, y + 26, { width: boxW - 16, lineBreak: false });
    doc
      .fillColor(C.muted)
      .font('Helvetica')
      .fontSize(7)
      .text(it.sub, x + 10, y + 50, { width: boxW - 16, lineBreak: false });
  });
  doc.x = M.left;
  doc.y = y + 84;
}

function starChart(doc: PDFKit.PDFDocument, dist: number[]) {
  const w = contentWidth(doc);
  const y0 = doc.y;
  const hBox = 148;
  doc.roundedRect(M.left, y0, w, hBox, 6).fillAndStroke(C.white, C.line);
  const maxV = Math.max(...dist, 1);
  const gap = 12;
  const barW = (w - gap * 6) / 5;
  const top = y0 + 26;
  const usable = hBox - 52;
  dist.forEach((v, i) => {
    const bh = (v / maxV) * usable;
    const x = M.left + gap + i * (barW + gap);
    const y = top + usable - bh;
    doc.roundedRect(x, y, barW, Math.max(bh, 2), 3).fill(C.star[i]);
    doc
      .fillColor(C.ink)
      .font('Helvetica-Bold')
      .fontSize(9)
      .text(String(v), x, y - 13, { width: barW, align: 'center', lineBreak: false });
    doc
      .fillColor(C.muted)
      .font('Helvetica')
      .fontSize(8)
      .text(`${i + 1}*`, x, top + usable + 6, {
        width: barW,
        align: 'center',
        lineBreak: false,
      });
  });
  doc.x = M.left;
  doc.y = y0 + hBox + 12;
}

function hBars(doc: PDFKit.PDFDocument, rows: { label: string; value: number }[]) {
  if (!rows.length) return;
  const maxV = Math.max(...rows.map((r) => r.value), 1);
  const barMax = contentWidth(doc) - 170;
  const y0 = doc.y;
  rows.forEach((row, i) => {
    const y = y0 + i * 20;
    doc
      .fillColor(C.ink)
      .font('Helvetica')
      .fontSize(8)
      .text(row.label.slice(0, 28), M.left, y, { width: 130, lineBreak: false });
    const bw = Math.max(2, (row.value / maxV) * barMax);
    doc.roundedRect(M.left + 140, y + 1, bw, 11, 2).fill(C.indigo);
    doc
      .fillColor(C.muted)
      .font('Helvetica')
      .fontSize(8)
      .text(String(row.value), M.left + 140 + bw + 6, y + 1, { lineBreak: false });
  });
  doc.x = M.left;
  doc.y = y0 + rows.length * 20 + 10;
}

function donut(
  doc: PDFKit.PDFDocument,
  cx: number,
  cy: number,
  r: number,
  a: number,
  b: number,
  lang: PdfLang
) {
  const total = Math.max(1, a + b);
  const sweepA = (a / total) * Math.PI * 2;
  const drawSlice = (start: number, sweep: number, color: string) => {
    if (sweep <= 0.001) return;
    const steps = Math.max(12, Math.ceil(sweep * 20));
    doc.save();
    doc.moveTo(cx, cy);
    for (let i = 0; i <= steps; i++) {
      const ang = start + (sweep * i) / steps;
      doc.lineTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
    }
    doc.closePath();
    doc.fill(color);
    doc.restore();
  };
  const start = -Math.PI / 2;
  drawSlice(start, sweepA, C.green);
  drawSlice(start + sweepA, Math.PI * 2 - sweepA, C.red);
  doc.circle(cx, cy, r * 0.58).fill(C.white);
  doc
    .fillColor(C.navy)
    .font('Helvetica-Bold')
    .fontSize(12)
    .text(String(a + b), cx - 18, cy - 8, { width: 36, align: 'center', lineBreak: false });
  doc
    .fillColor(C.muted)
    .font('Helvetica')
    .fontSize(7)
    .text(t(lang, 'total'), cx - 18, cy + 6, { width: 36, align: 'center', lineBreak: false });
}

function ensureSpace(doc: PDFKit.PDFDocument, need: number, ctx: HeaderCtx) {
  if (doc.y + need < doc.page.height - M.bottom) return;
  doc.addPage();
  header(doc, ctx.plan, ctx.periodo, ctx.depth, ctx.lang);
}

type HeaderCtx = { plan: string; periodo: string; depth: PdfDepth; lang: PdfLang };

export async function gerarRelatorioMensalPDF(
  db: Database,
  empresaId: string,
  mesAno: string,
  _callGroq?: (system: string, user: string) => Promise<string>,
  langRaw?: string | null
): Promise<Buffer> {
  let empresa: any = null;
  try {
    empresa = await db.get(
      'SELECT id, nome_empresa, plan, status, locale, idioma, language FROM empresas WHERE id = ?',
      [empresaId]
    );
  } catch {
    empresa = await db.get(
      'SELECT id, nome_empresa, plan, status FROM empresas WHERE id = ?',
      [empresaId]
    );
  }
  if (!empresa) throw new Error('Empresa nao encontrada.');
  if (!empresaTemPdf(empresa)) throw new Error('Plano nao elegivel para relatorio mensal.');

  const lang: PdfLang = normalizePdfLang(
    langRaw || empresa.locale || empresa.idioma || empresa.language
  );
  const planRaw = String(empresa.plan || empresa.status || 'trial').toLowerCase();
  const trial = isTrialPlan(planRaw) || isTrialPlan(String(empresa.status || ''));
  const depth = depthForPlan(planRaw, trial);
  const needUnits = depth === 'corp' || depth === 'rei';
  if (needUnits) {
    try {
      await ensureUnidadesSchema(db);
    } catch {
      /* */
    }
  }

  const [reviews, unidades] = await Promise.all([
    loadReviews(db, empresaId, mesAno).catch(() => [] as ReviewRow[]),
    needUnits ? loadUnidades(db, empresaId) : Promise.resolve([] as Unidade[]),
  ]);

  const dist = [0, 0, 0, 0, 0];
  let sum = 0,
    positive = 0,
    critical = 0;
  for (const r of reviews) {
    const n = Number(r.rating) || 0;
    sum += n;
    if (n >= 1 && n <= 5) dist[n - 1] += 1;
    if (n >= 4) positive += 1;
    if (n <= 3) critical += 1;
  }
  const total = reviews.length;
  const avg = total ? sum / total : 0;

  // Secoes por plano — Pro NUNCA puxa sentimento/tags
  const tags = depth === 'pro' ? [] : parseTags(reviews);
  const sent = depth === 'pro' ? null : sentimentOf(reviews);

  const periodo = monthPeriod(mesAno, lang);
  const dateLocale =
    lang === 'en' ? 'en-US' : lang === 'es' ? 'es-ES' : lang === 'zh' ? 'zh-CN' : 'pt-BR';
  const emissao = new Intl.DateTimeFormat(dateLocale, { dateStyle: 'long' }).format(new Date());
  const pLabel = trial ? 'Trial' : planLabel(planRaw);
  const nomeEmpresa = String(empresa.nome_empresa || 'Empresa');
  const ctx: HeaderCtx = { plan: pLabel, periodo, depth, lang };

  const doc = new PDFDocument({
    size: 'A4',
    margin: M.left,
    bufferPages: true,
    autoFirstPage: true,
    compress: true,
    info: {
      Title: `${nomeEmpresa} - ${mesAno} - ${pLabel}`,
      Author: 'Filtra.AI',
      Subject: `depth=${depth} | ${lang} | ${PDF_LAYOUT_VERSION}`,
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  header(doc, pLabel, periodo, depth, lang);
  doc
    .fillColor(C.navy)
    .font('Helvetica-Bold')
    .fontSize(18)
    .text(nomeEmpresa, M.left, doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.15);
  doc
    .fillColor(C.muted)
    .font('Helvetica')
    .fontSize(9)
    .text(`${t(lang, 'period')}: ${periodo}   |   ${t(lang, 'plan')} ${pLabel}`, {
      width: contentWidth(doc),
    });
  doc.moveDown(0.25);
  doc
    .fillColor(C.indigo)
    .font('Helvetica-Bold')
    .fontSize(8)
    .text(benefitsFor(depth, lang), { width: contentWidth(doc) });
  doc.moveDown(0.45);

  // Checklist visual de beneficios (diferente por plano)
  drawBenefitsBox(doc, depth, lang);

  // —— Todos os planos com PDF: KPIs + distribuicao ——
  title(doc, t(lang, 'summary'));
  kpis(doc, [
    { label: t(lang, 'volume'), value: String(total), sub: t(lang, 'volume_sub') },
    { label: t(lang, 'avg'), value: avg ? avg.toFixed(1) : '-', sub: t(lang, 'avg_sub') },
    {
      label: t(lang, 'critical'),
      value: String(critical),
      sub: t(lang, 'critical_sub'),
      color: C.red,
    },
    {
      label: t(lang, 'positive'),
      value: String(positive),
      sub: pct(positive, total),
      color: C.green,
    },
  ]);

  title(doc, t(lang, 'dist'));
  starChart(doc, dist);
  doc
    .fillColor(C.ink)
    .font('Helvetica')
    .fontSize(9)
    .text(
      t(lang, 'pos_vs_crit', {
        p: positive,
        pp: pct(positive, total),
        c: critical,
        cp: pct(critical, total),
      }),
      { width: contentWidth(doc) }
    );
  doc.moveDown(0.55);

  // —— Ultra+ : sentimento ——
  if (sent && (depth === 'ultra' || depth === 'corp' || depth === 'rei')) {
    ensureSpace(doc, 90, ctx);
    title(doc, t(lang, 'sentiment'));
    const w = contentWidth(doc);
    const bw = (w - 16) / 3;
    const y = doc.y;
    const boxes = [
      { t: t(lang, 'sent_pos'), v: sent.pos, c: C.green },
      { t: t(lang, 'sent_neu'), v: sent.neu, c: C.amber },
      { t: t(lang, 'sent_neg'), v: sent.neg, c: C.red },
    ];
    boxes.forEach((b, i) => {
      const x = M.left + i * (bw + 8);
      doc.roundedRect(x, y, bw, 44, 5).fillAndStroke(C.pale, C.line);
      doc
        .fillColor(b.c)
        .font('Helvetica-Bold')
        .fontSize(7)
        .text(b.t, x + 10, y + 8, { lineBreak: false });
      doc
        .fillColor(C.navy)
        .font('Helvetica-Bold')
        .fontSize(15)
        .text(String(b.v), x + 10, y + 22, { lineBreak: false });
    });
    doc.x = M.left;
    doc.y = y + 56;
  }

  // —— Ultra+ : temas IA ——
  if (tags.length && depth !== 'pro') {
    ensureSpace(doc, 40 + tags.length * 14, ctx);
    title(doc, t(lang, 'themes'));
    for (const tg of tags) {
      doc
        .fillColor(C.ink)
        .font('Helvetica')
        .fontSize(9)
        .text(`*  ${tg.tag}   (${tg.count})`, { width: contentWidth(doc) });
    }
    doc.moveDown(0.4);
  }

  // —— Rei only: donut + gargalos ——
  if (depth === 'rei') {
    ensureSpace(doc, 160, ctx);
    title(doc, t(lang, 'vision_rei'));
    const cy = doc.y + 55;
    donut(doc, M.left + 70, cy, 48, positive, critical, lang);
    doc.fillColor(C.ink).font('Helvetica').fontSize(9);
    doc.text(`${t(lang, 'positives')}: ${positive}`, M.left + 150, cy - 24, {
      lineBreak: false,
    });
    doc.text(`${t(lang, 'critiques')}: ${critical}`, M.left + 150, cy - 8, {
      lineBreak: false,
    });
    doc.text(`${t(lang, 'total_label')}: ${total}`, M.left + 150, cy + 8, {
      lineBreak: false,
    });
    doc.x = M.left;
    doc.y = cy + 70;
    if (tags.length) {
      title(doc, t(lang, 'bottlenecks'));
      hBars(
        doc,
        tags.slice(0, 6).map((tg) => ({ label: tg.tag, value: tg.count }))
      );
    }
  }

  if (total === 0) {
    doc
      .fillColor(C.muted)
      .font('Helvetica')
      .fontSize(9)
      .text(t(lang, 'empty'), { width: contentWidth(doc) });
  }

  // —— Corp / Rei: ranking + filiais ——
  if (depth === 'corp' || depth === 'rei') {
    if (!unidades.length) {
      ensureSpace(doc, 40, ctx);
      doc
        .fillColor(C.amber)
        .font('Helvetica')
        .fontSize(9)
        .text(t(lang, 'no_units'), { width: contentWidth(doc) });
    } else {
      type Group = { nome: string; list: ReviewRow[] };
      const groups: Group[] = [];
      for (const u of unidades) {
        const list = reviews.filter(
          (r) =>
            String(r.unidade_id || '') === u.id ||
            (u.slug && String(r.origin || '') === u.slug)
        );
        groups.push({ nome: u.nome, list });
      }
      const orphan = reviews.filter(
        (r) =>
          !unidades.some(
            (u) =>
              String(r.unidade_id || '') === u.id ||
              (u.slug && String(r.origin || '') === u.slug)
          )
      );
      if (orphan.length) groups.push({ nome: 'HQ', list: orphan });
      groups.sort(
        (a, b) => media(b.list) - media(a.list) || b.list.length - a.list.length
      );

      doc.addPage();
      header(doc, pLabel, periodo, depth, lang);
      title(doc, t(lang, 'ranking'));
      const w = contentWidth(doc);
      const headY = doc.y;
      doc.roundedRect(M.left, headY, w, 20, 4).fill(C.navy);
      doc.fillColor(C.white).font('Helvetica-Bold').fontSize(8);
      doc.text(t(lang, 'unit'), M.left + 10, headY + 5, { lineBreak: false });
      doc.text(t(lang, 'volume_col'), M.left + w * 0.5, headY + 5, { lineBreak: false });
      doc.text(t(lang, 'avg_col'), M.left + w * 0.65, headY + 5, { lineBreak: false });
      doc.text(t(lang, 'crit_col'), M.left + w * 0.8, headY + 5, { lineBreak: false });
      doc.y = headY + 26;
      groups.forEach((g, idx) => {
        const rowY = doc.y;
        if (idx % 2 === 0) doc.rect(M.left, rowY - 1, w, 17).fill(C.pale);
        const m = media(g.list);
        const crit = g.list.filter((r) => Number(r.rating) <= 3).length;
        doc.fillColor(C.ink).font('Helvetica').fontSize(9);
        doc.text(g.nome.slice(0, 34), M.left + 10, rowY, { lineBreak: false });
        doc.text(String(g.list.length), M.left + w * 0.5, rowY, { lineBreak: false });
        doc.text(m ? m.toFixed(1) : '-', M.left + w * 0.65, rowY, { lineBreak: false });
        doc.text(String(crit), M.left + w * 0.8, rowY, { lineBreak: false });
        doc.y = rowY + 18;
      });

      for (const g of groups) {
        if (!g.list.length) continue;
        doc.addPage();
        header(doc, pLabel, periodo, depth, lang);
        title(doc, `${t(lang, 'branch')} - ${g.nome}`);
        const m = media(g.list);
        const dLocal = [0, 0, 0, 0, 0];
        let pos = 0,
          crit = 0;
        for (const r of g.list) {
          const n = Number(r.rating) || 0;
          if (n >= 1 && n <= 5) dLocal[n - 1] += 1;
          if (n >= 4) pos += 1;
          if (n <= 3) crit += 1;
        }
        kpis(doc, [
          {
            label: t(lang, 'volume'),
            value: String(g.list.length),
            sub: t(lang, 'this_period'),
          },
          {
            label: t(lang, 'avg'),
            value: m ? m.toFixed(1) : '-',
            sub: t(lang, 'avg_sub'),
          },
          {
            label: t(lang, 'critical'),
            value: String(crit),
            sub: t(lang, 'critical_sub'),
            color: C.red,
          },
          {
            label: t(lang, 'positive'),
            value: String(pos),
            sub: pct(pos, g.list.length),
            color: C.green,
          },
        ]);
        title(doc, t(lang, 'dist_unit'));
        starChart(doc, dLocal);
        if (depth === 'rei') {
          const cy = doc.y + 50;
          donut(doc, M.left + 70, cy, 42, pos, crit, lang);
          doc.x = M.left;
          doc.y = cy + 60;
          const localTags = parseTags(g.list);
          if (localTags.length) {
            title(doc, t(lang, 'themes_unit'));
            hBars(
              doc,
              localTags.slice(0, 5).map((tg) => ({ label: tg.tag, value: tg.count }))
            );
          }
        }
      }
    }
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    footer(doc, emissao, i + 1, range.count, lang);
  }

  await new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', reject);
    doc.end();
  });

  const buf = Buffer.concat(chunks);
  if (!buf.length || buf.slice(0, 4).toString() !== '%PDF') {
    throw new Error('PDF gerado invalido');
  }
  return buf;
}
