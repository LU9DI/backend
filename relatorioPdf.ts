/**
 * Relatório mensal PDF — profundidade e visual conforme o plano.
 *
 * Pro:      capa + KPIs + barras 1★–5★ + positivas/críticas
 * Ultra:    + temas IA + sentimento + insights
 * Corp:     + ranking de filiais + 1 página por filial
 * Rei:      + donut + gargalos + página rica por filial
 * Trial:    trata como Ultra (tudo incluso no teste)
 */
import type { Database } from 'sqlite';
import PDFDocument from 'pdfkit';
import { empresaTemPdf, isTrialPlan, planLabel } from './lib/plans.js';

type ReviewRow = {
  rating: number;
  comment?: string | null;
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

type Depth = 'pro' | 'ultra' | 'corp' | 'rei';

const C = {
  navy: '#0f172a',
  indigo: '#4f46e5',
  indigoSoft: '#818cf8',
  ink: '#1e293b',
  muted: '#64748b',
  line: '#e2e8f0',
  pale: '#f8fafc',
  card: '#ffffff',
  red: '#dc2626',
  green: '#16a34a',
  amber: '#d97706',
  white: '#ffffff',
  star: ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'],
};

const PAGE = { left: 44, right: 44, bottom: 52 };

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
  } catch (e: any) {
    console.warn('[pdf] ensure unidades:', e?.message || e);
  }
  for (const ddl of ['unidade_id TEXT', 'origin TEXT']) {
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

function depthForPlan(plan: string, trial: boolean): Depth {
  if (trial) return 'ultra';
  const p = plan.toLowerCase();
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

function distNotas(reviews: ReviewRow[]): number[] {
  const d = [0, 0, 0, 0, 0];
  for (const r of reviews) {
    const n = Number(r.rating);
    if (n >= 1 && n <= 5) d[n - 1] += 1;
  }
  return d;
}

function media(reviews: ReviewRow[]): number {
  if (!reviews.length) return 0;
  return reviews.reduce((sum, r) => sum + Number(r.rating || 0), 0) / reviews.length;
}

function percent(value: number, total: number): string {
  return total ? `${Math.round((value / total) * 100)}%` : '0%';
}

function parseTags(reviews: ReviewRow[]): { tag: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const r of reviews) {
    if (!r.ai_tags) continue;
    try {
      const parsed = JSON.parse(String(r.ai_tags));
      if (Array.isArray(parsed)) {
        for (const tag of parsed) {
          const key = String(tag).trim().slice(0, 48);
          if (key) counts[key] = (counts[key] || 0) + 1;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));
}

function sentimentBreak(reviews: ReviewRow[]): { pos: number; neu: number; neg: number } {
  let pos = 0;
  let neu = 0;
  let neg = 0;
  for (const r of reviews) {
    const s = String(r.sentiment || '').toLowerCase();
    if (s.includes('pos') || s === 'positive') pos += 1;
    else if (s.includes('neg') || s === 'negative') neg += 1;
    else if (s) neu += 1;
    else {
      const n = Number(r.rating);
      if (n >= 4) pos += 1;
      else if (n <= 2) neg += 1;
      else neu += 1;
    }
  }
  return { pos, neu, neg };
}

async function loadReviews(db: Database, empresaId: string, mesAno: string): Promise<ReviewRow[]> {
  let rows: any[] = [];
  try {
    rows = (await db.all(
      `SELECT * FROM reviews WHERE empresa_id = ? ORDER BY id DESC LIMIT 3000`,
      [empresaId]
    )) as any[];
  } catch (e: any) {
    console.warn('[pdf] SELECT reviews:', e?.message || e);
    try {
      rows = (await db.all(
        `SELECT rating, comment, is_test, ai_tags, sentiment, unidade_id, origin FROM reviews WHERE empresa_id = ? LIMIT 3000`,
        [empresaId]
      )) as any[];
    } catch {
      return [];
    }
  }
  return (rows || [])
    .filter((r) => !isTest(r as ReviewRow))
    .filter((r) => {
      const d = rowDate(r as ReviewRow);
      if (!d) return true;
      return d.startsWith(mesAno);
    }) as ReviewRow[];
}

async function loadUnidades(db: Database, empresaId: string): Promise<Unidade[]> {
  try {
    const rows = (await db.all(
      `SELECT id, nome, slug FROM unidades WHERE empresa_id = ? AND (ativo IS NULL OR ativo = 1 OR ativo = true) ORDER BY nome ASC`,
      [empresaId]
    )) as any[];
    return (rows || []).map((u) => ({
      id: String(u.id),
      nome: String(u.nome || 'Filial'),
      slug: u.slug,
    }));
  } catch {
    return [];
  }
}

function drawHeader(
  doc: PDFKit.PDFDocument,
  opts: { planLabel: string; periodo: string; depth: Depth }
) {
  const w = doc.page.width;
  doc.rect(0, 0, w, 72).fill(C.navy);
  doc.rect(0, 72, w, 3).fill(C.indigo);

  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(16).text('Filtra.AI', PAGE.left, 18);
  doc
    .fillColor(C.indigoSoft)
    .font('Helvetica')
    .fontSize(8)
    .text('Relatório mensal de reputação', PAGE.left, 40);

  doc
    .fillColor(C.white)
    .font('Helvetica-Bold')
    .fontSize(9)
    .text(opts.planLabel.toUpperCase(), w - 140, 18, { width: 96, align: 'right' });
  doc
    .fillColor('#94a3b8')
    .font('Helvetica')
    .fontSize(8)
    .text(opts.periodo, w - 140, 34, { width: 96, align: 'right' });
  doc
    .fillColor('#64748b')
    .font('Helvetica')
    .fontSize(7)
    .text(depthBadge(opts.depth), w - 140, 48, { width: 96, align: 'right' });
}

function depthBadge(d: Depth): string {
  if (d === 'rei') return 'Nível Rei · completo';
  if (d === 'corp') return 'Nível Corporativo';
  if (d === 'ultra') return 'Nível Ultra';
  return 'Nível Pro';
}

function drawFooter(doc: PDFKit.PDFDocument, emissao: string, pageNo?: number, totalPages?: number) {
  const y = doc.page.height - 36;
  doc
    .strokeColor(C.line)
    .lineWidth(0.5)
    .moveTo(PAGE.left, y - 8)
    .lineTo(doc.page.width - PAGE.right, y - 8)
    .stroke();
  const left = `Filtra.AI · Emitido em ${emissao}`;
  const right =
    pageNo && totalPages ? `Página ${pageNo} de ${totalPages}` : 'Dados do painel · sem projeção futura';
  doc.fillColor(C.muted).font('Helvetica').fontSize(7).text(left, PAGE.left, y, {
    width: 280,
  });
  doc
    .fillColor(C.muted)
    .font('Helvetica')
    .fontSize(7)
    .text(right, doc.page.width - PAGE.right - 180, y, { width: 180, align: 'right' });
}

function sectionTitle(doc: PDFKit.PDFDocument, title: string) {
  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(12).text(title, PAGE.left);
  doc.moveDown(0.35);
}

function drawKpis(
  doc: PDFKit.PDFDocument,
  items: { title: string; value: string; desc: string; accent?: string }[]
) {
  const width = doc.page.width - PAGE.left - PAGE.right;
  const gap = 10;
  const n = items.length;
  const kw = (width - gap * (n - 1)) / n;
  const y = doc.y;
  items.forEach((it, i) => {
    const x = PAGE.left + i * (kw + gap);
    doc.roundedRect(x, y, kw, 78, 8).fillAndStroke(C.pale, C.line);
    doc.roundedRect(x, y, 4, 78, 2).fill(it.accent || C.indigo);
    doc
      .fillColor(C.indigo)
      .font('Helvetica-Bold')
      .fontSize(7)
      .text(it.title.toUpperCase(), x + 12, y + 12, { width: kw - 20 });
    doc
      .fillColor(C.navy)
      .font('Helvetica-Bold')
      .fontSize(20)
      .text(it.value, x + 12, y + 28, { width: kw - 20 });
    doc
      .fillColor(C.muted)
      .font('Helvetica')
      .fontSize(7.5)
      .text(it.desc, x + 12, y + 54, { width: kw - 20 });
  });
  doc.y = y + 94;
}

function drawStarBars(doc: PDFKit.PDFDocument, dist: number[]) {
  const width = doc.page.width - PAGE.left - PAGE.right;
  const chartY = doc.y;
  const chartH = 158;
  doc.roundedRect(PAGE.left, chartY, width, chartH, 8).fillAndStroke(C.card, C.line);
  const maxV = Math.max(...dist, 1);
  const barGap = 14;
  const barW = (width - barGap * 6) / 5;
  const top = chartY + 30;
  const h = chartH - 54;
  dist.forEach((v, i) => {
    const barH = (v / maxV) * h;
    const bx = PAGE.left + barGap + i * (barW + barGap);
    const by = top + h - barH;
    doc.roundedRect(bx, by, barW, Math.max(barH, 2), 4).fill(C.star[i]);
    doc
      .fillColor(C.ink)
      .font('Helvetica-Bold')
      .fontSize(9)
      .text(String(v), bx, by - 14, { width: barW, align: 'center' });
    doc
      .fillColor(C.muted)
      .font('Helvetica')
      .fontSize(8)
      .text(`${i + 1} ★`, bx, top + h + 8, { width: barW, align: 'center' });
  });
  doc.y = chartY + chartH + 14;
}

/** Donut simplificado (Rei) — anel com arcos por fatia. */
function drawDonut(
  doc: PDFKit.PDFDocument,
  cx: number,
  cy: number,
  r: number,
  slices: { value: number; color: string; label: string }[]
) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  let angle = -Math.PI / 2;
  for (const sl of slices) {
    const sweep = (sl.value / total) * Math.PI * 2;
    const steps = Math.max(8, Math.ceil(Math.abs(sweep) * 24));
    doc.save();
    doc.moveTo(cx, cy);
    for (let i = 0; i <= steps; i++) {
      const a = angle + (sweep * i) / steps;
      doc.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    doc.closePath();
    doc.fill(sl.color);
    doc.restore();
    angle += sweep;
  }
  // furo central
  doc.circle(cx, cy, r * 0.55).fill(C.white);
  doc
    .fillColor(C.navy)
    .font('Helvetica-Bold')
    .fontSize(11)
    .text(String(total), cx - 20, cy - 8, { width: 40, align: 'center' });
  doc
    .fillColor(C.muted)
    .font('Helvetica')
    .fontSize(7)
    .text('total', cx - 20, cy + 6, { width: 40, align: 'center' });
}

function drawHBars(
  doc: PDFKit.PDFDocument,
  rows: { label: string; value: number }[],
  maxW: number
) {
  const maxV = Math.max(...rows.map((r) => r.value), 1);
  const y0 = doc.y;
  rows.forEach((row, i) => {
    const y = y0 + i * 22;
    doc.fillColor(C.ink).font('Helvetica').fontSize(8).text(row.label, PAGE.left, y, { width: 140 });
    const bw = (row.value / maxV) * maxW;
    doc.roundedRect(PAGE.left + 150, y, Math.max(bw, 2), 12, 3).fill(C.indigo);
    doc
      .fillColor(C.muted)
      .font('Helvetica')
      .fontSize(8)
      .text(String(row.value), PAGE.left + 150 + bw + 6, y + 1);
  });
  doc.y = y0 + rows.length * 22 + 8;
}

function benefitsLine(depth: Depth): string {
  if (depth === 'rei')
    return 'Inclui: KPIs · distribuição · sentimento · temas IA · donut · gargalos · ranking e páginas por filial.';
  if (depth === 'corp')
    return 'Inclui: KPIs · distribuição · temas IA · ranking de unidades · página demonstrativa por filial.';
  if (depth === 'ultra')
    return 'Inclui: KPIs · distribuição de notas · sentimento · temas detectados pela IA.';
  return 'Inclui: KPIs do período · distribuição 1★–5★ · positivas vs críticas.';
}

export async function gerarRelatorioMensalPDF(
  db: Database,
  empresaId: string,
  mesAno: string,
  _callGroq?: (system: string, user: string) => Promise<string>
): Promise<Buffer> {
  try {
    await ensureUnidadesSchema(db);
  } catch (e: any) {
    console.warn('[pdf] ensureUnidadesSchema:', e?.message || e);
  }

  const empresa = await db.get('SELECT * FROM empresas WHERE id = ?', [empresaId]);
  if (!empresa) throw new Error('Empresa não encontrada.');

  const plan = String(empresa.plan || empresa.status || 'trial').toLowerCase();
  if (!empresaTemPdf(empresa)) {
    throw new Error('Plano não elegível para relatório mensal.');
  }

  const reviews = await loadReviews(db, empresaId, mesAno).catch(() => [] as ReviewRow[]);
  const trial = isTrialPlan(plan) || isTrialPlan(String(empresa.status || ''));
  const depth = depthForPlan(plan, trial);
  const unidades =
    depth === 'corp' || depth === 'rei' ? await loadUnidades(db, empresaId) : [];

  const dist = distNotas(reviews);
  const total = reviews.length;
  const avg = media(reviews);
  const positive = reviews.filter((r) => Number(r.rating) >= 4).length;
  const critical = reviews.filter((r) => Number(r.rating) <= 3).length;
  const tags = depth !== 'pro' ? parseTags(reviews) : [];
  const sent = depth === 'ultra' || depth === 'corp' || depth === 'rei' ? sentimentBreak(reviews) : null;

  const [ano, mes] = mesAno.split('-');
  const nomesMeses = [
    'Janeiro',
    'Fevereiro',
    'Março',
    'Abril',
    'Maio',
    'Junho',
    'Julho',
    'Agosto',
    'Setembro',
    'Outubro',
    'Novembro',
    'Dezembro',
  ];
  const periodo =
    ano && Number(mes) >= 1 && Number(mes) <= 12
      ? `${nomesMeses[Number(mes) - 1]} / ${ano}`
      : mesAno;
  const emissao = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' }).format(new Date());
  const pLabel = trial ? 'Trial' : planLabel(plan);
  const nomeEmpresa = String(empresa.nome_empresa || 'Empresa');

  const doc = new PDFDocument({
    size: 'A4',
    margin: PAGE.left,
    bufferPages: true,
    info: {
      Title: `${nomeEmpresa} — Relatório ${mesAno}`,
      Author: 'Filtra.AI',
      Subject: `Reputação · ${pLabel}`,
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  // ——— Página 1: resumo ———
  drawHeader(doc, { planLabel: pLabel, periodo, depth });
  doc.y = 92;

  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(20).text(nomeEmpresa, PAGE.left);
  doc
    .moveDown(0.2)
    .fillColor(C.muted)
    .font('Helvetica')
    .fontSize(9)
    .text(`Período: ${periodo}  ·  Plano ${pLabel}`);
  doc.moveDown(0.25);
  doc.fillColor(C.indigoSoft).font('Helvetica').fontSize(8).text(benefitsLine(depth), {
    width: doc.page.width - PAGE.left - PAGE.right,
  });
  doc.moveDown(0.7);

  sectionTitle(doc, 'Resumo do período');
  drawKpis(doc, [
    { title: 'Volume', value: String(total), desc: 'Avaliações válidas' },
    { title: 'Nota média', value: avg ? avg.toFixed(1) : '—', desc: 'Escala 1 a 5' },
    {
      title: 'Críticas',
      value: String(critical),
      desc: 'Notas 1–3',
      accent: C.red,
    },
    {
      title: 'Positivas',
      value: String(positive),
      desc: percent(positive, total),
      accent: C.green,
    },
  ]);

  sectionTitle(doc, 'Distribuição de notas');
  drawStarBars(doc, dist);

  doc
    .fillColor(C.ink)
    .font('Helvetica')
    .fontSize(9)
    .text(
      `Positivas (4–5★): ${positive} (${percent(positive, total)})    ·    Críticas (1–3★): ${critical} (${percent(critical, total)})`,
      { width: doc.page.width - PAGE.left - PAGE.right }
    );
  doc.moveDown(0.6);

  // Ultra+: sentimento
  if (sent) {
    sectionTitle(doc, 'Sentimento (IA + nota)');
    const w = doc.page.width - PAGE.left - PAGE.right;
    const boxW = (w - 20) / 3;
    const y = doc.y;
    const boxes = [
      { t: 'Positivo', v: sent.pos, c: C.green },
      { t: 'Neutro', v: sent.neu, c: C.amber },
      { t: 'Negativo', v: sent.neg, c: C.red },
    ];
    boxes.forEach((b, i) => {
      const x = PAGE.left + i * (boxW + 10);
      doc.roundedRect(x, y, boxW, 48, 6).fillAndStroke(C.pale, C.line);
      doc.fillColor(b.c).font('Helvetica-Bold').fontSize(8).text(b.t.toUpperCase(), x + 10, y + 10);
      doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(16).text(String(b.v), x + 10, y + 24);
    });
    doc.y = y + 60;
  }

  // Ultra+: temas IA
  if (tags.length) {
    sectionTitle(doc, 'Temas registrados pela IA');
    for (const t of tags.slice(0, depth === 'pro' ? 0 : 8)) {
      doc.fillColor(C.ink).font('Helvetica').fontSize(9).text(`  •  ${t.tag}  (${t.count})`);
    }
    doc.moveDown(0.5);
  }

  // Rei: donut + gargalos na página 1 se couber
  if (depth === 'rei') {
    if (doc.y > 620) {
      drawFooter(doc, emissao);
      doc.addPage();
      drawHeader(doc, { planLabel: pLabel, periodo, depth });
      doc.y = 92;
    }
    sectionTitle(doc, 'Visão Rei · positivas vs críticas');
    const cx = PAGE.left + 90;
    const cy = doc.y + 70;
    drawDonut(doc, cx, cy, 58, [
      { value: positive, color: C.green, label: 'Positivas' },
      { value: critical, color: C.red, label: 'Críticas' },
      {
        value: Math.max(0, total - positive - critical),
        color: C.line,
        label: 'Outros',
      },
    ]);
    doc.fillColor(C.ink).font('Helvetica').fontSize(9);
    doc.text(`Positivas: ${positive}`, PAGE.left + 180, cy - 30);
    doc.text(`Críticas: ${critical}`, PAGE.left + 180, cy - 12);
    doc.text(`Total: ${total}`, PAGE.left + 180, cy + 6);
    doc.y = cy + 80;

    if (tags.length) {
      sectionTitle(doc, 'Gargalos / temas mais citados');
      drawHBars(
        doc,
        tags.slice(0, 6).map((t) => ({ label: t.tag, value: t.count })),
        220
      );
    }
  }

  if (total === 0) {
    doc
      .fillColor(C.muted)
      .font('Helvetica')
      .fontSize(10)
      .text(
        'Nenhuma avaliação válida neste período. O relatório permanece disponível; os indicadores sobem com novos feedbacks.',
        { width: doc.page.width - PAGE.left - PAGE.right }
      );
  }

  // Corp / Rei: ranking de filiais
  if (depth === 'corp' || depth === 'rei') {
    drawFooter(doc, emissao);
    doc.addPage();
    drawHeader(doc, { planLabel: pLabel, periodo, depth });
    doc.y = 92;
    sectionTitle(doc, 'Ranking de unidades');

    const groups: { nome: string; id: string; list: ReviewRow[] }[] = [];
    if (unidades.length) {
      for (const u of unidades) {
        const list = reviews.filter(
          (r) => String(r.unidade_id || '') === u.id || String(r.origin || '') === u.slug
        );
        groups.push({ nome: u.nome, id: u.id, list });
      }
      const orphan = reviews.filter(
        (r) =>
          !unidades.some(
            (u) => String(r.unidade_id || '') === u.id || String(r.origin || '') === u.slug
          )
      );
      if (orphan.length) groups.push({ nome: 'Matriz / Sem filial', id: '_', list: orphan });
    } else {
      groups.push({ nome: 'Matriz / Geral', id: '_', list: reviews });
    }

    groups.sort((a, b) => media(b.list) - media(a.list) || b.list.length - a.list.length);

    const width = doc.page.width - PAGE.left - PAGE.right;
    doc.roundedRect(PAGE.left, doc.y, width, 22, 4).fill(C.navy);
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(8);
    doc.text('Unidade', PAGE.left + 10, doc.y + 6, { continued: false });
    // cabeçalho manual
    let hy = doc.y;
    doc.text('Unidade', PAGE.left + 10, hy + 6);
    doc.text('Vol.', PAGE.left + width * 0.48, hy + 6);
    doc.text('Média', PAGE.left + width * 0.62, hy + 6);
    doc.text('Críticas', PAGE.left + width * 0.78, hy + 6);
    doc.y = hy + 28;

    groups.forEach((g, idx) => {
      const m = media(g.list);
      const crit = g.list.filter((r) => Number(r.rating) <= 3).length;
      if (idx % 2 === 0) {
        doc.rect(PAGE.left, doc.y - 2, width, 18).fill(C.pale);
      }
      doc.fillColor(C.ink).font('Helvetica').fontSize(9);
      doc.text(g.nome.slice(0, 36), PAGE.left + 10, doc.y);
      doc.text(String(g.list.length), PAGE.left + width * 0.48, doc.y - 11);
      doc.text(m ? m.toFixed(1) : '—', PAGE.left + width * 0.62, doc.y - 11);
      doc.text(String(crit), PAGE.left + width * 0.78, doc.y - 11);
      doc.moveDown(0.55);
    });

    // Página por filial
    for (const g of groups) {
      drawFooter(doc, emissao);
      doc.addPage();
      drawHeader(doc, { planLabel: pLabel, periodo, depth });
      doc.y = 92;
      sectionTitle(doc, `Filial · ${g.nome}`);
      const m = media(g.list);
      const d = distNotas(g.list);
      const pos = g.list.filter((r) => Number(r.rating) >= 4).length;
      const crit = g.list.filter((r) => Number(r.rating) <= 3).length;

      drawKpis(doc, [
        { title: 'Volume', value: String(g.list.length), desc: 'Neste período' },
        { title: 'Média', value: m ? m.toFixed(1) : '—', desc: '1 a 5' },
        { title: 'Críticas', value: String(crit), desc: '1–3★', accent: C.red },
        { title: 'Positivas', value: String(pos), desc: percent(pos, g.list.length), accent: C.green },
      ]);

      sectionTitle(doc, 'Distribuição na filial');
      drawStarBars(doc, d);

      if (depth === 'rei') {
        const cx = PAGE.left + 90;
        const cy = doc.y + 65;
        sectionTitle(doc, 'Donut da filial');
        drawDonut(doc, cx, cy, 52, [
          { value: pos, color: C.green, label: 'Pos' },
          { value: crit, color: C.red, label: 'Crit' },
        ]);
        doc.y = cy + 70;
        const localTags = parseTags(g.list);
        if (localTags.length) {
          sectionTitle(doc, 'Temas na filial');
          drawHBars(
            doc,
            localTags.slice(0, 5).map((t) => ({ label: t.tag, value: t.count })),
            200
          );
        }
      }
    }
  }

  // Numeração de páginas
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    drawFooter(doc, emissao, i + 1, range.count);
  }

  await new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', (err) => reject(err));
    doc.end();
  });

  const buf = Buffer.concat(chunks);
  if (!buf.length) throw new Error('PDF gerado vazio');
  return buf;
}
