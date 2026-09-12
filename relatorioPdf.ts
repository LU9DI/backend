/**
 * Relatório mensal PDF — mesma base factual do painel do cliente.
 *
 * Pro: KPIs + distribuição de notas.
 * Ultra: Pro + mix positivo/crítico + tendência + temas já registrados pela IA.
 * Corporativo/Rei: Ultra + visão multi-unidades e detalhes por unidade.
 *
 * Regra importante: este arquivo NÃO prevê resultados, NÃO cria métricas e NÃO
 * chama IA para inventar conteúdo. Avaliações de teste são excluídas, como no painel.
 */
import type { Database } from 'sqlite';
import PDFDocument from 'pdfkit';
import { planTemPdf } from './lib/plans.js';

export type PlanPdf = 'ultra' | 'corporativo' | 'rei' | 'pro';

type ReviewRow = {
  rating: number;
  comment?: string | null;
  unidade_id?: string | null;
  origin?: string | null;
  createdAt?: string;
  is_test?: number | boolean | null;
  ai_tags?: string | null;
  sentiment?: string | null;
};

type UnidadeRow = { id: string; nome: string; slug?: string | null };
type CallGroq = (system: string, user: string) => Promise<string>;

type UnitGroup = {
  unidade: UnidadeRow | { id: string; nome: string };
  reviews: ReviewRow[];
};

const COLORS = {
  navy: '#17233c',
  blue: '#4f46e5',
  ink: '#26364d',
  muted: '#65748a',
  line: '#d9e1eb',
  pale: '#f5f7fa',
  paleBlue: '#eef2ff',
  green: '#16804b',
  red: '#b42318',
  white: '#ffffff',
  star: ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'],
};

const PAGE = { left: 42, right: 42, bottom: 46 };
const FOOTER_Y = 806;

export async function ensureUnidadesSchema(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS unidades (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      slug TEXT,
      ativo INTEGER DEFAULT 1,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (empresa_id) REFERENCES empresas(id)
    )
  `);
  const cols = (await db.all(`PRAGMA table_info(reviews)`)).map((c: any) => c.name);
  if (!cols.includes('unidade_id')) await db.exec(`ALTER TABLE reviews ADD COLUMN unidade_id TEXT`);
  if (!cols.includes('origin')) await db.exec(`ALTER TABLE reviews ADD COLUMN origin TEXT`);
}

function isTest(r: ReviewRow): boolean {
  return Number(r.is_test) === 1 || r.is_test === true;
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
      const parsed = JSON.parse(r.ai_tags);
      if (Array.isArray(parsed)) {
        for (const tag of parsed) {
          const key = String(tag).trim();
          if (key) counts[key] = (counts[key] || 0) + 1;
        }
      }
    } catch {
      // dado inválido não entra no relatório
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag, count]) => ({ tag, count }));
}

function serieUltimosDias(reviews: ReviewRow[], dias = 14) {
  const map = new Map<string, { total: number; positivas: number; negativas: number; soma: number }>();
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  for (let i = dias - 1; i >= 0; i--) {
    const d = new Date(hoje);
    d.setDate(d.getDate() - i);
    map.set(d.toISOString().slice(0, 10), { total: 0, positivas: 0, negativas: 0, soma: 0 });
  }
  for (const r of reviews) {
    const bucket = map.get(String(r.createdAt || '').slice(0, 10));
    if (!bucket) continue;
    const rating = Number(r.rating) || 0;
    bucket.total += 1;
    bucket.soma += rating;
    if (rating >= 4) bucket.positivas += 1;
    if (rating <= 3) bucket.negativas += 1;
  }
  return [...map.entries()].map(([dia, b]) => ({
    dia,
    total: b.total,
    positivas: b.positivas,
    negativas: b.negativas,
    media: b.total ? Math.round((b.soma / b.total) * 10) / 10 : 0,
  }));
}

function agrupadoPorUnidade(reviews: ReviewRow[], unidades: UnidadeRow[]): UnitGroup[] {
  const map = new Map<string, ReviewRow[]>();
  for (const r of reviews) {
    const key = r.unidade_id || r.origin || '_matriz';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  const byId = new Map(unidades.map((u) => [u.id, u]));
  const groups: UnitGroup[] = [];
  for (const [key, list] of map.entries()) {
    if (byId.has(key)) groups.push({ unidade: byId.get(key)!, reviews: list });
    else groups.push({ unidade: { id: key, nome: key === '_matriz' ? 'Matriz / Geral' : key }, reviews: list });
  }
  for (const u of unidades) if (!map.has(u.id)) groups.push({ unidade: u, reviews: [] });
  return groups.sort((a, b) => media(b.reviews) - media(a.reviews) || b.reviews.length - a.reviews.length);
}

function sectionTitle(doc: PDFKit.PDFDocument, title: string, subtitle?: string) {
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(13).text(title, { lineBreak: false });
  if (subtitle) doc.moveDown(0.15).fillColor(COLORS.muted).font('Helvetica').fontSize(8.5).text(subtitle, { lineBreak: false });
  doc.moveDown(0.5);
}

function drawKpi(doc: PDFKit.PDFDocument, title: string, value: string, desc: string, x: number, y: number, width: number, accent = COLORS.blue) {
  doc.roundedRect(x, y, width, 76, 7).fillAndStroke(COLORS.pale, COLORS.line);
  doc.roundedRect(x, y, 4, 76, 2).fill(accent);
  doc.fillColor(COLORS.blue).font('Helvetica-Bold').fontSize(7.5).text(title.toUpperCase(), x + 12, y + 10, { width: width - 20, lineBreak: false });
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(18).text(value, x + 12, y + 28, { width: width - 20, lineBreak: false });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5).text(desc, x + 12, y + 52, { width: width - 20, lineBreak: false });
}

function drawHeader(doc: PDFKit.PDFDocument, empresaNome: string, periodo: string, plan: string, subtitle: string) {
  doc.rect(0, 0, doc.page.width, 78).fill(COLORS.navy);
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(18).text('FILTRA.AI', PAGE.left, 20, { lineBreak: false });
  doc.fillColor('#c7d2e5').font('Helvetica').fontSize(8.5).text(subtitle, PAGE.left, 46, { lineBreak: false });
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(8).text(plan.toUpperCase(), doc.page.width - 132, 23, { width: 90, align: 'right', lineBreak: false });
  doc.fillColor('#c7d2e5').font('Helvetica').fontSize(7.5).text(periodo, doc.page.width - 132, 40, { width: 90, align: 'right', lineBreak: false });
  doc.y = 98;
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(18).text(empresaNome, PAGE.left, doc.y, { lineBreak: false });
  doc.moveDown(0.15).fillColor(COLORS.muted).font('Helvetica').fontSize(8).text(`Período analisado: ${periodo}`, { lineBreak: false });
  doc.moveDown(0.8);
}

function drawFooter(doc: PDFKit.PDFDocument, empresaNome: string, page: number, total: number) {
  const y = FOOTER_Y;
  doc.save();
  doc.strokeColor(COLORS.line).lineWidth(0.5).moveTo(PAGE.left, y - 8).lineTo(doc.page.width - PAGE.right, y - 8).stroke();
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7).text(`© FILTRA.AI · uso exclusivo de ${empresaNome}`, PAGE.left, y, { width: 280, lineBreak: false, height: 10 });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7).text(`Página ${page}/${total}`, doc.page.width - PAGE.right - 80, y, { width: 80, align: 'right', lineBreak: false, height: 10 });
  doc.restore();
}

function drawWatermark(doc: PDFKit.PDFDocument) {
  const cx = doc.page.width / 2;
  const cy = doc.page.height / 2;
  doc.save();
  doc.opacity(0.06);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(46);
  doc.rotate(-45, { origin: [cx, cy] });
  doc.text('FILTRA.AI', cx - 150, cy - 20, { width: 300, align: 'center', lineBreak: false, height: 55 });
  doc.restore();
}

function drawBarChart(doc: PDFKit.PDFDocument, x: number, y: number, width: number, height: number, values: number[]) {
  const labels = ['1 star', '2 stars', '3 stars', '4 stars', '5 stars'];
  const max = Math.max(...values, 1);
  const gap = 10;
  const barW = (width - gap * 6) / 5;
  const top = y + 28;
  const chartH = height - 52;
  doc.roundedRect(x, y, width, height, 7).fillAndStroke(COLORS.white, COLORS.line);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(9).text('Quantidade por nota', x + 12, y + 10, { lineBreak: false });
  for (let i = 0; i <= 4; i++) {
    const gy = top + chartH - (chartH * i) / 4;
    doc.strokeColor(COLORS.line).lineWidth(0.5).moveTo(x + 10, gy).lineTo(x + width - 10, gy).stroke();
  }
  values.forEach((v, i) => {
    const barH = (v / max) * chartH;
    const bx = x + gap + i * (barW + gap);
    const by = top + chartH - barH;
    doc.roundedRect(bx, by, barW, Math.max(barH, 1), 4).fill(COLORS.star[i]);
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8).text(String(v), bx, by - 12, { width: barW, align: 'center', lineBreak: false });
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5).text(labels[i], bx, top + chartH + 5, { width: barW, align: 'center', lineBreak: false });
  });
}

function drawDonut(doc: PDFKit.PDFDocument, x: number, y: number, size: number, positive: number, negative: number) {
  const total = Math.max(positive + negative, 1);
  const cx = x + size / 2;
  const cy = y + size / 2 + 10;
  const radius = size / 2 - 8;
  const positiveAngle = (positive / total) * Math.PI * 2;
  doc.roundedRect(x, y, size + 22, size + 42, 7).fillAndStroke(COLORS.white, COLORS.line);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(8.5).text('Positivas vs críticas', x + 9, y + 8, { lineBreak: false });
  for (let i = 0; i < 64; i++) {
    const a0 = -Math.PI / 2 + (i / 64) * Math.PI * 2;
    const a1 = -Math.PI / 2 + ((i + 1) / 64) * Math.PI * 2;
    const fromTop = ((i + 0.5) / 64) * Math.PI * 2;
    doc.moveTo(cx, cy).lineTo(cx + Math.cos(a0) * radius, cy + Math.sin(a0) * radius).lineTo(cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius).closePath().fill(fromTop <= positiveAngle ? COLORS.green : COLORS.red);
  }
  doc.circle(cx, cy, radius * 0.55).fill(COLORS.white);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(13).text(percent(positive, total), cx - 25, cy - 8, { width: 50, align: 'center', lineBreak: false });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7).text('positivas', cx - 28, cy + 8, { width: 56, align: 'center', lineBreak: false });
}

function drawTrend(doc: PDFKit.PDFDocument, x: number, y: number, width: number, height: number, serie: ReturnType<typeof serieUltimosDias>) {
  const max = Math.max(...serie.map((s) => s.total), 1);
  doc.roundedRect(x, y, width, height, 7).fillAndStroke(COLORS.white, COLORS.line);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(9).text('Tendência · últimos 14 dias', x + 12, y + 10, { lineBreak: false });
  const left = x + 14;
  const top = y + 34;
  const w = width - 28;
  const h = height - 54;
  const points = serie.map((s, i) => ({ x: left + (i / Math.max(serie.length - 1, 1)) * w, y: top + h - (s.total / max) * h }));
  for (let i = 0; i <= 4; i++) {
    const gy = top + h - (h * i) / 4;
    doc.strokeColor(COLORS.line).lineWidth(0.5).moveTo(left, gy).lineTo(left + w, gy).stroke();
  }
  if (points.length > 1) {
    doc.strokeColor(COLORS.blue).lineWidth(2).moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) doc.lineTo(p.x, p.y);
    doc.stroke();
  }
  points.forEach((p, i) => {
    doc.circle(p.x, p.y, 2.5).fill(COLORS.blue);
    if (i === 0 || i === points.length - 1 || i % 3 === 0) {
      const d = serie[i].dia.slice(5).split('-').reverse().join('/');
      doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.5).text(d, p.x - 12, top + h + 5, { width: 24, align: 'center', lineBreak: false, height: 9 });
    }
  });
}

function drawTags(doc: PDFKit.PDFDocument, x: number, y: number, width: number, tags: { tag: string; count: number }[]) {
  const rows = Math.max(tags.length, 1);
  const height = 34 + rows * 21;
  doc.roundedRect(x, y, width, height, 7).fillAndStroke(COLORS.white, COLORS.line);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(9).text('Temas já registrados pela IA', x + 12, y + 10, { lineBreak: false });
  if (!tags.length) {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8).text('Nenhum tema registrado no período.', x + 12, y + 30, { lineBreak: false });
    return height;
  }
  const max = Math.max(...tags.map((t) => t.count), 1);
  tags.forEach((t, i) => {
    const ry = y + 29 + i * 21;
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(8).text(t.tag.slice(0, 30), x + 12, ry, { width: 110, lineBreak: false });
    doc.roundedRect(x + 128, ry + 1, Math.max(3, (t.count / max) * (width - 170)), 9, 3).fill(COLORS.blue);
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5).text(String(t.count), x + width - 32, ry, { width: 20, align: 'right', lineBreak: false });
  });
  return height;
}

function drawUnitTable(doc: PDFKit.PDFDocument, x: number, y: number, width: number, groups: UnitGroup[]) {
  const rowH = 23;
  const headerH = 25;
  const height = headerH + Math.max(groups.length, 1) * rowH;
  doc.roundedRect(x, y, width, height, 7).fillAndStroke(COLORS.white, COLORS.line);
  doc.rect(x, y, width, headerH).fill(COLORS.pale);
  doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(7.2);
  doc.text('UNIDADE', x + 12, y + 8, { width: 190, lineBreak: false });
  doc.text('VOLUME', x + 210, y + 8, { width: 55, lineBreak: false });
  doc.text('MÉDIA', x + 275, y + 8, { width: 55, lineBreak: false });
  doc.text('CRÍTICAS', x + 340, y + 8, { width: 60, lineBreak: false });
  doc.text('POSITIVAS', x + 410, y + 8, { width: 60, lineBreak: false });
  groups.forEach((g, i) => {
    const ry = y + headerH + i * rowH;
    const cr = g.reviews.filter((r) => Number(r.rating) <= 3).length;
    const po = g.reviews.filter((r) => Number(r.rating) >= 4).length;
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(8).text(g.unidade.nome.slice(0, 34), x + 12, ry + 7, { width: 190, lineBreak: false });
    doc.text(String(g.reviews.length), x + 210, ry + 7, { width: 55, lineBreak: false });
    doc.text(media(g.reviews) ? media(g.reviews).toFixed(2) : '-', x + 275, ry + 7, { width: 55, lineBreak: false });
    doc.text(String(cr), x + 340, ry + 7, { width: 60, lineBreak: false });
    doc.text(String(po), x + 410, ry + 7, { width: 60, lineBreak: false });
  });
  return height;
}

function drawUnitDetail(doc: PDFKit.PDFDocument, empresaNome: string, periodo: string, unidadeNome: string, reviews: ReviewRow[]) {
  doc.addPage();
  drawHeader(doc, empresaNome, periodo, 'UNIDADE', 'Detalhamento da unidade');
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(15).text(unidadeNome, PAGE.left, doc.y, { lineBreak: false });
  doc.moveDown(0.7);
  const dist = distNotas(reviews);
  const avg = media(reviews);
  const positive = reviews.filter((r) => Number(r.rating) >= 4).length;
  const critical = reviews.filter((r) => Number(r.rating) <= 3).length;
  const gap = 10;
  const width = doc.page.width - PAGE.left - PAGE.right;
  const kw = (width - gap * 2) / 3;
  const y = doc.y;
  drawKpi(doc, 'Avaliações', String(reviews.length), 'Volume no período', PAGE.left, y, kw);
  drawKpi(doc, 'Nota média', avg ? avg.toFixed(2) : '-', 'Escala 1 a 5', PAGE.left + kw + gap, y, kw);
  drawKpi(doc, 'Críticas', String(critical), 'Notas 1-3', PAGE.left + (kw + gap) * 2, y, kw, COLORS.red);
  doc.y = y + 94;
  sectionTitle(doc, 'Distribuição de notas', 'Dados reais da unidade no período');
  drawBarChart(doc, PAGE.left, doc.y, width, 160, dist);
  doc.y += 178;
  drawKpi(doc, 'Positivas', String(positive), `${percent(positive, reviews.length)} do volume`, PAGE.left, doc.y, kw, COLORS.green);
  drawKpi(doc, 'Críticas', String(critical), `${percent(critical, reviews.length)} do volume`, PAGE.left + kw + gap, doc.y, kw, COLORS.red);
  drawKpi(doc, 'Sem previsão', '-', 'O relatório não estima resultados futuros', PAGE.left + (kw + gap) * 2, doc.y, kw, COLORS.blue);
}

export async function gerarRelatorioMensalPDF(db: Database, empresaId: string, mesAno: string, _callGroq?: CallGroq): Promise<Buffer> {
  await ensureUnidadesSchema(db);
  const empresa = await db.get('SELECT * FROM empresas WHERE id = ?', [empresaId]);
  if (!empresa) throw new Error('Empresa não encontrada.');
  const plan = String(empresa.plan || '').toLowerCase();
  if (!planTemPdf(plan)) throw new Error('Plano não elegível para relatório mensal.');

  const rawReviews: ReviewRow[] = await db.all(
    `SELECT rating, comment, unidade_id, origin, createdAt, is_test, ai_tags, sentiment
     FROM reviews WHERE empresa_id = ? AND strftime('%Y-%m', createdAt) = ?
     AND COALESCE(is_test, 0) <> 1`,
    [empresaId, mesAno]
  );
  const reviews = rawReviews.filter((r) => !isTest(r));
  const ultraPlus = plan === 'ultra' || plan === 'corporativo' || plan === 'rei';
  const multi = plan === 'corporativo' || plan === 'rei';
  const isRei = plan === 'rei';

  const unidades: UnidadeRow[] = multi
    ? await db.all(`SELECT id, nome, slug FROM unidades WHERE empresa_id = ? AND ativo = 1 ORDER BY nome`, [empresaId])
    : [];

  const dist = distNotas(reviews);
  const total = reviews.length;
  const avg = media(reviews);
  const positive = reviews.filter((r) => Number(r.rating) >= 4).length;
  const critical = reviews.filter((r) => Number(r.rating) <= 3).length;
  const crises24h = reviews.filter((r) => Number(r.rating) <= 2 && Date.now() - new Date(String(r.createdAt || '')).getTime() <= 24 * 60 * 60 * 1000).length;
  const tags = ultraPlus ? parseTags(reviews) : [];
  const serie = ultraPlus ? serieUltimosDias(reviews, 14) : [];

  const [ano, mes] = mesAno.split('-');
  const nomesMeses = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const periodo = ano && Number(mes) >= 1 && Number(mes) <= 12 ? `${nomesMeses[Number(mes) - 1]} / ${ano}` : mesAno;
  const emissao = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' }).format(new Date());

  const doc = new PDFDocument({ size: 'A4', margin: PAGE.left, bufferPages: true, info: { Title: `${empresa.nome_empresa} - Relatório ${mesAno}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (c) => chunks.push(c));

  drawWatermark(doc);
  doc.on('pageAdded', () => drawWatermark(doc));

  const subtitle = isRei ? 'Relatório executivo - dados do painel' : multi ? 'Relatório multi-unidades - dados do painel' : ultraPlus ? 'Relatório analítico - dados do painel' : 'Relatório mensal - dados do painel';
  drawHeader(doc, empresa.nome_empresa, periodo, plan, subtitle);

  sectionTitle(doc, 'Resumo do período', 'Somente indicadores calculados a partir das avaliações válidas');
  const width = doc.page.width - PAGE.left - PAGE.right;
  const gap = 10;
  const kw = (width - gap * 2) / 3;
  const y = doc.y;
  drawKpi(doc, 'Volume', String(total), 'Avaliações válidas', PAGE.left, y, kw);
  drawKpi(doc, 'Nota média', avg ? avg.toFixed(1) : '-', 'Escala 1 a 5', PAGE.left + kw + gap, y, kw);
  drawKpi(doc, 'Críticas', String(critical), 'Notas 1-3', PAGE.left + (kw + gap) * 2, y, kw, COLORS.red);
  doc.y = y + 94;

  sectionTitle(doc, 'Distribuição de notas', 'Volume de avaliações por estrela');
  drawBarChart(doc, PAGE.left, doc.y, width, 160, dist);
  doc.y += 178;

  if (ultraPlus) {
    if (doc.y + 410 > doc.page.height - PAGE.bottom) {
      doc.addPage();
      drawHeader(doc, empresa.nome_empresa, periodo, plan, subtitle);
    }
    sectionTitle(doc, 'Análises disponíveis no painel', 'Indicadores derivados dos dados já registrados');
    const colW = (width - gap) / 2;
    drawDonut(doc, PAGE.left, doc.y, 118, positive, critical);
    drawKpi(doc, 'Positivas', String(positive), `${percent(positive, total)} do volume`, PAGE.left + colW + gap, doc.y, colW, COLORS.green);
    doc.y += 166;
    drawKpi(doc, 'Críticas nas últimas 24h', String(crises24h), 'Notas 1-2 registradas', PAGE.left, doc.y, colW, crises24h > 0 ? COLORS.red : COLORS.blue);
    drawKpi(doc, 'Taxa positiva', percent(positive, total), 'Notas 4-5 / total', PAGE.left + colW + gap, doc.y, colW, COLORS.green);
    doc.y += 98;

    if (doc.y + 198 > doc.page.height - PAGE.bottom) {
      doc.addPage();
      drawHeader(doc, empresa.nome_empresa, periodo, plan, subtitle);
    }
    drawTrend(doc, PAGE.left, doc.y, width, 180, serie);
    doc.y += 198;

    const tagsH = 34 + Math.max(tags.length, 1) * 21;
    if (doc.y + tagsH + 18 > doc.page.height - PAGE.bottom) {
      doc.addPage();
      drawHeader(doc, empresa.nome_empresa, periodo, plan, subtitle);
    }
    const actualTagsH = drawTags(doc, PAGE.left, doc.y, width, tags);
    doc.y += actualTagsH + 18;
  }

  if (multi) {
    const groups = agrupadoPorUnidade(reviews, unidades);
    const tableH = 25 + Math.max(groups.length, 1) * 23;
    if (doc.y + tableH + 60 > doc.page.height - PAGE.bottom) {
      doc.addPage();
      drawHeader(doc, empresa.nome_empresa, periodo, plan, subtitle);
    }
    sectionTitle(doc, 'Visão multi-unidades', isRei ? 'Comparativo executivo baseado nos dados atuais' : 'Comparativo das unidades ativas');
    drawUnitTable(doc, PAGE.left, doc.y, width, groups);
    doc.y += tableH + 15;
    for (const group of groups) drawUnitDetail(doc, empresa.nome_empresa, periodo, group.unidade.nome, group.reviews);
  }

  if (doc.y + 180 > doc.page.height - PAGE.bottom) {
    doc.addPage();
    drawHeader(doc, empresa.nome_empresa, periodo, plan, subtitle);
  }
  sectionTitle(doc, 'Leitura do período', 'Resumo factual - sem projeções');
  const factual = total === 0
    ? 'Não houve avaliações válidas no período selecionado.'
    : `Foram registradas ${total} avaliações válidas, com nota média ${avg.toFixed(1)}. ${positive} avaliações foram positivas (4-5) e ${critical} foram críticas (1-3).`;
  doc.roundedRect(PAGE.left, doc.y, width, 72, 7).fillAndStroke(COLORS.paleBlue, COLORS.line);
  doc.fillColor(COLORS.ink).font('Helvetica').fontSize(9).text(factual, PAGE.left + 14, doc.y + 16, { width: width - 28, lineGap: 2, lineBreak: false, height: 40 });
  doc.y += 92;
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5).text(`Emitido em ${emissao}. O relatório reproduz dados registrados no painel do cliente; não contém previsão de resultados futuros.`, PAGE.left, doc.y, { width, lineBreak: false, height: 10 });

  await new Promise<void>((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      drawFooter(doc, empresa.nome_empresa, i - range.start + 1, range.count);
    }
    doc.end();
  });
  return Buffer.concat(chunks);
}
