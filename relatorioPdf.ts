/**
 * Relatório mensal PDF — layout profissional por plano (nível do sample Filtra.AI).
 * Pro / Ultra / Corporativo / Rei (+ Trial = Ultra)
 * Logo, marca d'água FILTRA.AI e rodapé com direitos reservados.
 */
import type { Database } from 'sqlite';
import PDFDocument from 'pdfkit';
import { planTemPdf, isTrialPlan, planLabel } from './lib/plans.js';
import {
  normalizePdfLang,
  monthPeriod,
  t,
  featureChecklist,
  planTitle,
  planSubtitle,
  type PdfLang,
  type PdfDepth,
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

type Unidade = { id: string; nome: string };

export const PDF_LAYOUT_VERSION = 'v9-sample';

const C = {
  teal: '#0d6e6e',
  tealDark: '#0a5555',
  navy: '#0f172a',
  ink: '#1e293b',
  muted: '#64748b',
  line: '#e2e8f0',
  pale: '#f8fafc',
  paleTeal: '#ecfdf5',
  white: '#ffffff',
  red: '#dc2626',
  green: '#16a34a',
  amber: '#d97706',
  locked: '#94a3b8',
  star: ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'] as string[],
};

const M = { left: 40, right: 40, bottom: 56 };

export function depthForPlan(plan: string, trial: boolean): PdfDepth {
  if (trial) return 'ultra';
  const p = String(plan || '').toLowerCase();
  if (p === 'rei') return 'rei';
  if (p === 'corporativo' || p === 'corp') return 'corp';
  if (p === 'ultra') return 'ultra';
  return 'pro';
}

function isTest(r: ReviewRow): boolean {
  return Number(r.is_test) === 1 || r.is_test === true;
}
function rowDate(r: ReviewRow): string {
  return String(r.createdAt || r.createdat || r.created_at || '');
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
    `SELECT rating, is_test, ai_tags, sentiment, unidade_id, origin, created_at FROM reviews WHERE empresa_id = ? LIMIT 5000`,
    `SELECT rating, is_test, ai_tags, sentiment, unidade_id, origin, "createdAt" as created_at FROM reviews WHERE empresa_id = ? LIMIT 5000`,
    `SELECT rating, is_test, ai_tags, sentiment, unidade_id, origin FROM reviews WHERE empresa_id = ? LIMIT 5000`,
  ];
  let rows: any[] = [];
  for (const sql of sqls) {
    try {
      rows = (await db.all(sql, [empresaId])) as any[];
      if (rows?.length !== undefined) break;
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
      `SELECT id, nome FROM unidades WHERE empresa_id = ? ORDER BY nome ASC`,
      [empresaId]
    )) as any[];
    return (rows || []).map((u) => ({ id: String(u.id), nome: String(u.nome || 'Filial') }));
  } catch {
    return [];
  }
}

function cw(doc: PDFKit.PDFDocument) {
  return doc.page.width - M.left - M.right;
}

function drawWatermark(doc: PDFKit.PDFDocument, lang: PdfLang) {
  const cx = doc.page.width / 2;
  const cy = doc.page.height / 2;
  doc.save();
  doc.opacity(0.06);
  doc.fillColor(C.tealDark).font('Helvetica-Bold').fontSize(52);
  doc.rotate(-28, { origin: [cx, cy] });
  doc.text(t(lang, 'watermark'), cx - 170, cy - 24, { width: 340, align: 'center', lineBreak: false });
  doc.restore();
  doc.opacity(1);
}

function drawFooter(
  doc: PDFKit.PDFDocument,
  page: number,
  total: number,
  empresaNome: string,
  depth: PdfDepth,
  lang: PdfLang
) {
  const y = doc.page.height - 48;
  doc.strokeColor(C.line).lineWidth(0.6).moveTo(M.left, y - 10).lineTo(doc.page.width - M.right, y - 10).stroke();

  // Linha principal no estilo do sample
  const planKey = depth === 'corp' ? 'CORPORATIVO' : depth.toUpperCase();
  doc.fillColor(C.muted).font('Helvetica').fontSize(7.5).text(
    t(lang, 'footer_line', { plano: planKey }),
    M.left,
    y - 4,
    { width: cw(doc), align: 'center', lineBreak: false }
  );

  // Direitos + página
  doc.fillColor(C.muted).font('Helvetica').fontSize(6).text(
    t(lang, 'rights', { empresa: empresaNome.slice(0, 42) }),
    M.left,
    y + 10,
    { width: cw(doc) - 60, lineBreak: false }
  );
  doc.fillColor(C.muted).font('Helvetica').fontSize(6.5).text(
    t(lang, 'page', { n: page, t: total }),
    doc.page.width - M.right - 56,
    y + 10,
    { width: 56, align: 'right', lineBreak: false }
  );
}

function sectionTitle(doc: PDFKit.PDFDocument, text: string) {
  doc.x = M.left;
  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(11).text(text, M.left, doc.y, { width: cw(doc) });
  const yLine = doc.y + 2;
  doc.strokeColor(C.teal).lineWidth(1.8).moveTo(M.left, yLine).lineTo(M.left + 52, yLine).stroke();
  doc.moveDown(0.5);
}

/** Hero teal no estilo do sample: título do plano + empresa + ciclo dentro do card. */
function drawPlanHero(
  doc: PDFKit.PDFDocument,
  depth: PdfDepth,
  lang: PdfLang,
  empresaNome: string,
  cicloLabel: string,
  contaLabel: string
) {
  const w = cw(doc);
  const y0 = 36;
  const h = 96;
  doc.roundedRect(M.left, y0, w, h, 12).fill(C.teal);

  // Marca discreta no canto
  doc.fillColor('#99f6e4').font('Helvetica-Bold').fontSize(8).text('Filtra.AI', M.left + 18, y0 + 12, {
    lineBreak: false,
  });

  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(20).text(planTitle(depth, lang), M.left + 18, y0 + 28, {
    width: w - 36,
    lineBreak: false,
  });
  doc.fillColor('#d1fae5').font('Helvetica').fontSize(9).text(planSubtitle(depth, lang), M.left + 18, y0 + 52, {
    width: w - 36,
    lineBreak: false,
  });
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(10).text(empresaNome.slice(0, 48), M.left + 18, y0 + 68, {
    width: w - 36,
    lineBreak: false,
  });
  doc.fillColor('#a7f3d0').font('Helvetica').fontSize(8).text(`${cicloLabel} · ${contaLabel}`, M.left + 18, y0 + 82, {
    width: w - 36,
    lineBreak: false,
  });

  doc.x = M.left;
  doc.y = y0 + h + 14;
}

function drawBenefits(doc: PDFKit.PDFDocument, depth: PdfDepth, lang: PdfLang) {
  const items = featureChecklist(depth, lang);
  const included = items.filter((i) => i.included);
  const excluded = items.filter((i) => !i.included);
  const w = cw(doc);
  const gap = 12;
  const colW = (w - gap) / 2;
  const y0 = doc.y;
  const rowH = 15;
  const pad = 12;
  const hIn = pad + 18 + included.length * rowH + pad;
  const hOut = pad + 18 + Math.max(excluded.length, 1) * rowH + pad;
  const h = Math.max(hIn, hOut, 58);

  doc.roundedRect(M.left, y0, colW, h, 10).fillAndStroke(C.paleTeal, C.line);
  doc.fillColor(C.tealDark).font('Helvetica-Bold').fontSize(8).text(
    t(lang, 'benefits_in').toUpperCase(),
    M.left + pad,
    y0 + pad,
    { width: colW - pad * 2, lineBreak: false }
  );
  included.forEach((it, i) => {
    const y = y0 + pad + 18 + i * rowH;
    doc.fillColor(C.green).font('Helvetica-Bold').fontSize(9).text('✓', M.left + pad, y, { lineBreak: false });
    doc.fillColor(C.ink).font('Helvetica').fontSize(8.5).text(it.label, M.left + pad + 14, y, {
      width: colW - pad * 2 - 14,
      lineBreak: false,
    });
  });

  const x2 = M.left + colW + gap;
  doc.roundedRect(x2, y0, colW, h, 10).fillAndStroke(C.pale, C.line);
  doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8).text(
    t(lang, 'benefits_out').toUpperCase(),
    x2 + pad,
    y0 + pad,
    { width: colW - pad * 2, lineBreak: false }
  );
  if (!excluded.length) {
    doc.fillColor(C.locked).font('Helvetica').fontSize(8).text('—', x2 + pad, y0 + pad + 18, { lineBreak: false });
  } else {
    excluded.forEach((it, i) => {
      const y = y0 + pad + 18 + i * rowH;
      doc.fillColor(C.locked).font('Helvetica').fontSize(8.5).text('○  ' + it.label, x2 + pad, y, {
        width: colW - pad * 2,
        lineBreak: false,
      });
    });
  }
  doc.x = M.left;
  doc.y = y0 + h + 14;
}

function drawKpis(
  doc: PDFKit.PDFDocument,
  items: { label: string; value: string; sub: string; accent?: string }[]
) {
  const w = cw(doc);
  const gap = 8;
  const n = items.length;
  const boxW = (w - gap * (n - 1)) / n;
  const y = doc.y;
  items.forEach((it, i) => {
    const x = M.left + i * (boxW + gap);
    doc.roundedRect(x, y, boxW, 64, 10).fillAndStroke(C.white, C.line);
    doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(6.5).text(it.label.toUpperCase(), x + 10, y + 10, {
      width: boxW - 20,
      lineBreak: false,
    });
    doc.fillColor(it.accent || C.navy).font('Helvetica-Bold').fontSize(20).text(it.value, x + 10, y + 26, {
      width: boxW - 20,
      lineBreak: false,
    });
    doc.fillColor(C.muted).font('Helvetica').fontSize(7).text(it.sub, x + 10, y + 48, {
      width: boxW - 20,
      lineBreak: false,
    });
  });
  doc.x = M.left;
  doc.y = y + 76;
}

function drawDistHorizontal(doc: PDFKit.PDFDocument, dist: number[]) {
  const w = cw(doc);
  const maxV = Math.max(...dist, 1);
  const barMax = w - 72;
  dist.forEach((v, i) => {
    const y = doc.y;
    doc.fillColor(C.ink).font('Helvetica').fontSize(9).text(`${i + 1}★`, M.left, y, { width: 28, lineBreak: false });
    doc.roundedRect(M.left + 30, y + 2, barMax, 11, 5).fill(C.pale);
    const bw = Math.max(v > 0 ? 4 : 0, (v / maxV) * barMax);
    if (bw > 0) doc.roundedRect(M.left + 30, y + 2, bw, 11, 5).fill(C.star[i]);
    doc.fillColor(C.muted).font('Helvetica').fontSize(8).text(String(v), M.left + 30 + barMax + 6, y, {
      lineBreak: false,
    });
    doc.y = y + 17;
  });
  doc.moveDown(0.35);
}

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
      'SELECT id, nome_empresa, plan, status, locale, idioma, language, criado_em, expira_em FROM empresas WHERE id = ?',
      [empresaId]
    );
  } catch {
    empresa = await db.get('SELECT id, nome_empresa, plan, status FROM empresas WHERE id = ?', [empresaId]);
  }
  if (!empresa) throw new Error('Empresa não encontrada.');
  if (!planTemPdf(empresa.plan || empresa.status)) {
    throw new Error('Plano não elegível para relatório mensal.');
  }

  const lang = normalizePdfLang(langRaw || empresa.locale || empresa.idioma || empresa.language);
  const planRaw = String(empresa.plan || empresa.status || 'trial').toLowerCase();
  const trial = isTrialPlan(planRaw) || isTrialPlan(String(empresa.status || ''));
  const depth = depthForPlan(planRaw, trial);
  const needUnits = depth === 'corp' || depth === 'rei';

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
  const tags = depth === 'pro' ? [] : parseTags(reviews);
  const sent = depth === 'pro' ? null : sentimentOf(reviews);

  const periodo = monthPeriod(mesAno, lang);
  const pLabel = trial ? 'Trial' : planLabel(planRaw);
  const nomeEmpresa = String(empresa.nome_empresa || 'Empresa');

  let cicloLabel = `${t(lang, 'period')}: ${periodo}`;
  try {
    if (empresa.criado_em && empresa.expira_em) {
      const a = new Date(empresa.criado_em);
      const b = new Date(empresa.expira_em);
      if (Number.isFinite(a.getTime()) && Number.isFinite(b.getTime())) {
        const fmt = (d: Date) =>
          d.toLocaleDateString(lang === 'en' ? 'en-GB' : lang === 'es' ? 'es-ES' : 'pt-BR');
        cicloLabel = `${t(lang, 'period')} ${fmt(a)} – ${fmt(b)}`;
      }
    }
  } catch {
    /* */
  }

  const doc = new PDFDocument({
    size: 'A4',
    margin: M.left,
    bufferPages: true,
    autoFirstPage: true,
    compress: true,
    info: {
      Title: `${planTitle(depth, lang)} — ${nomeEmpresa}`,
      Author: 'Filtra.AI',
      Subject: `depth=${depth} | ${lang} | ${PDF_LAYOUT_VERSION}`,
      Keywords: 'Filtra.AI, reputação, relatório',
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  const paintPageChrome = () => drawWatermark(doc, lang);
  paintPageChrome();
  doc.on('pageAdded', paintPageChrome);

  drawPlanHero(doc, depth, lang, nomeEmpresa, cicloLabel, `Conta: ${pLabel}`);
  drawBenefits(doc, depth, lang);

  sectionTitle(doc, t(lang, 'summary'));
  drawKpis(doc, [
    { label: t(lang, 'volume'), value: String(total), sub: t(lang, 'volume_sub') },
    { label: t(lang, 'avg'), value: avg ? avg.toFixed(1) : '—', sub: t(lang, 'avg_sub') },
    {
      label: t(lang, 'positive'),
      value: String(positive),
      sub: `${pct(positive, total)} · ${t(lang, 'positive_sub')}`,
      accent: C.green,
    },
    {
      label: t(lang, 'critical'),
      value: String(critical),
      sub: `${pct(critical, total)} · ${t(lang, 'critical_sub')}`,
      accent: C.red,
    },
  ]);

  sectionTitle(doc, t(lang, 'dist'));
  drawDistHorizontal(doc, dist);

  if (sent && depth !== 'pro') {
    sectionTitle(doc, t(lang, 'sentiment'));
    const w = cw(doc);
    const bw = (w - 16) / 3;
    const y = doc.y;
    const boxes = [
      { t: t(lang, 'sent_pos'), v: sent.pos, c: C.green },
      { t: t(lang, 'sent_neu'), v: sent.neu, c: C.amber },
      { t: t(lang, 'sent_neg'), v: sent.neg, c: C.red },
    ];
    boxes.forEach((b, i) => {
      const x = M.left + i * (bw + 8);
      doc.roundedRect(x, y, bw, 50, 10).fillAndStroke(C.white, C.line);
      doc.fillColor(b.c).font('Helvetica-Bold').fontSize(7).text(b.t.toUpperCase(), x + 12, y + 10, {
        lineBreak: false,
      });
      doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(18).text(String(b.v), x + 12, y + 24, {
        lineBreak: false,
      });
      doc.fillColor(C.muted).font('Helvetica').fontSize(7).text(pct(b.v, total), x + 12, y + 42, {
        lineBreak: false,
      });
    });
    doc.x = M.left;
    doc.y = y + 62;
  }

  if (depth !== 'pro') {
    sectionTitle(doc, t(lang, 'themes'));
    if (!tags.length) {
      doc.roundedRect(M.left, doc.y, cw(doc), 40, 8).fillAndStroke(C.pale, C.line);
      doc.fillColor(C.muted).font('Helvetica').fontSize(8).text(t(lang, 'themes_empty'), M.left + 14, doc.y + 14, {
        width: cw(doc) - 28,
      });
      doc.y += 52;
    } else {
      for (const tg of tags) {
        doc.fillColor(C.ink).font('Helvetica').fontSize(9).text(`•  ${tg.tag}  (${tg.count})`, {
          width: cw(doc),
        });
      }
      doc.moveDown(0.35);
    }
  }

  if (needUnits && unidades.length) {
    sectionTitle(doc, t(lang, 'ranking'));
    const byUnit = new Map<string, ReviewRow[]>();
    for (const r of reviews) {
      const key = r.unidade_id || '_matriz';
      if (!byUnit.has(key)) byUnit.set(key, []);
      byUnit.get(key)!.push(r);
    }
    const map = new Map(unidades.map((u) => [u.id, u]));
    const groups = [...byUnit.entries()]
      .map(([key, list]) => {
        const m = list.length ? list.reduce((s, r) => s + Number(r.rating), 0) / list.length : 0;
        return {
          nome: key === '_matriz' ? 'Matriz / Geral' : map.get(key)?.nome || key,
          volume: list.length,
          media: m,
          crit: list.filter((r) => Number(r.rating) <= 3).length,
        };
      })
      .sort((a, b) => b.media - a.media);

    const tableY = doc.y;
    const rowH = 16;
    doc.roundedRect(M.left, tableY, cw(doc), 20 + groups.length * rowH, 8).fillAndStroke(C.white, C.line);
    doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(7);
    doc.text('UNIDADE', M.left + 12, tableY + 6, { width: 200, lineBreak: false });
    doc.text('VOL', M.left + 220, tableY + 6, { width: 40, lineBreak: false });
    doc.text('MÉDIA', M.left + 270, tableY + 6, { width: 50, lineBreak: false });
    doc.text('CRÍT.', M.left + 340, tableY + 6, { width: 40, lineBreak: false });
    groups.forEach((g, i) => {
      const y = tableY + 22 + i * rowH;
      doc.fillColor(C.ink).font('Helvetica').fontSize(8);
      doc.text(g.nome.slice(0, 36), M.left + 12, y, { width: 200, lineBreak: false });
      doc.text(String(g.volume), M.left + 220, y, { width: 40, lineBreak: false });
      doc.text(g.media ? g.media.toFixed(1) : '—', M.left + 270, y, { width: 50, lineBreak: false });
      doc.text(String(g.crit), M.left + 340, y, { width: 40, lineBreak: false });
    });
    doc.y = tableY + 28 + groups.length * rowH;
  }

  if (total === 0) {
    doc.fillColor(C.muted).font('Helvetica').fontSize(9).text(t(lang, 'empty'), { width: cw(doc) });
  }

  await new Promise<void>((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      drawFooter(doc, i - range.start + 1, range.count, nomeEmpresa, depth, lang);
    }
    doc.end();
  });

  const buf = Buffer.concat(chunks);
  if (!buf.length || buf.subarray(0, 4).toString() !== '%PDF') {
    throw new Error('PDF inválido.');
  }
  return buf;
}

export async function ensureUnidadesSchema(db: Database): Promise<void> {
  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS unidades (
      id TEXT PRIMARY KEY, empresa_id TEXT NOT NULL, nome TEXT NOT NULL,
      slug TEXT, ativo INTEGER DEFAULT 1)`);
  } catch {
    /* */
  }
}
