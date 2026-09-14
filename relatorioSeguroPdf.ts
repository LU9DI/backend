/**
 * Gerador seguro do relatório mensal.
 * Regra: nenhuma métrica é calculada pela IA; todos os números vêm de
 * normalizeReportReviews() e passam por assertReportConsistency().
 */
import type { Database } from 'sqlite';
import PDFDocument from 'pdfkit';
import {
  normalizeReportReviews,
  assertReportConsistency,
  formatAverage,
  formatPercent,
  type ReportReview,
} from './lib/reportMetrics.js';

type Unidade = { id: string; nome: string; slug?: string | null };

const COLORS = {
  navy: '#17233c',
  blue: '#2d5b9f',
  ink: '#26364d',
  muted: '#65748a',
  line: '#d9e1eb',
  pale: '#f5f7fa',
  paleBlue: '#edf3fa',
  green: '#1a7f4b',
  red: '#b91c1c',
  amber: '#b45309',
  stars: ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'],
};

function drawKpi(doc: PDFKit.PDFDocument, title: string, value: string, desc: string, x: number, y: number, w: number) {
  doc.roundedRect(x, y, w, 78, 6).fillAndStroke(COLORS.pale, COLORS.line);
  doc.fillColor(COLORS.blue).font('Helvetica-Bold').fontSize(7.5).text(title.toUpperCase(), x + 10, y + 10, { width: w - 20 });
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(18).text(value, x + 10, y + 28, { width: w - 20 });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5).text(desc, x + 10, y + 52, { width: w - 20 });
}

function section(doc: PDFKit.PDFDocument, title: string, subtitle: string) {
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(12).text(title);
  doc.moveDown(0.15).fillColor(COLORS.muted).font('Helvetica').fontSize(8).text(subtitle);
  doc.moveDown(0.45);
}

function drawDistribution(doc: PDFKit.PDFDocument, values: number[], x: number, y: number, width: number) {
  const height = 150;
  const gap = 8;
  const max = Math.max(...values, 1);
  const barW = (width - gap * (values.length + 1)) / values.length;
  doc.roundedRect(x, y, width, height, 6).fillAndStroke('#ffffff', COLORS.line);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(9).text('Quantidade por nota', x + 12, y + 8);
  for (let i = 0; i <= 4; i++) {
    const gy = y + 22 + (height - 40) - ((height - 40) * i) / 4;
    doc.moveTo(x + 8, gy).lineTo(x + width - 8, gy).strokeColor(COLORS.line).lineWidth(0.5).stroke();
  }
  values.forEach((value, i) => {
    const chartH = height - 40;
    const bh = (value / max) * chartH;
    const bx = x + gap + i * (barW + gap);
    const by = y + 22 + chartH - bh;
    doc.roundedRect(bx, by, barW, Math.max(bh, 1), 3).fill(COLORS.stars[i]);
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8).text(String(value), bx, by - 12, { width: barW, align: 'center' });
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5).text(`${i + 1}★`, bx, y + height - 17, { width: barW, align: 'center' });
  });
}

function drawMix(doc: PDFKit.PDFDocument, positive: number, critical: number, x: number, y: number, width: number) {
  const total = positive + critical;
  doc.roundedRect(x, y, width, 74, 6).fillAndStroke('#ffffff', COLORS.line);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(9).text('Composição das avaliações', x + 12, y + 10);
  const p = total ? positive / total : 0;
  const barW = width - 24;
  doc.roundedRect(x + 12, y + 30, barW, 12, 4).fill(COLORS.pale);
  if (p > 0) doc.roundedRect(x + 12, y + 30, barW * p, 12, 4).fill(COLORS.green);
  doc.fillColor(COLORS.ink).font('Helvetica').fontSize(8).text(`Positivas (4–5): ${positive}`, x + 12, y + 49);
  doc.text(`Críticas (1–3): ${critical}`, x + width / 2, y + 49);
}

function unidadeMetrics(reviews: ReportReview[]) {
  return normalizeReportReviews(reviews);
}

export async function gerarRelatorioMensalPDFSeguro(db: Database, empresaId: string, mesAno: string): Promise<Buffer> {
  const empresa = await db.get('SELECT * FROM empresas WHERE id = ?', [empresaId]);
  if (!empresa) throw new Error('Empresa não encontrada.');

  const plan = String(empresa.plan || '').toLowerCase();
  if (!['ultra', 'pro', 'corporativo', 'rei'].includes(plan)) {
    throw new Error('Plano não elegível para relatório mensal.');
  }

  // O filtro de teste é deliberado: dados de teste jamais podem contaminar números comerciais.
  const rows: ReportReview[] = await db.all(
    `SELECT rating, comment, unidade_id, origin, createdAt
       FROM reviews
      WHERE empresa_id = ?
        AND strftime('%Y-%m', createdAt) = ?
        AND IFNULL(is_test, 0) = 0`,
    [empresaId, mesAno]
  );

  const metrics = normalizeReportReviews(rows);
  assertReportConsistency(metrics);

  // Falhar fechado é melhor do que publicar um relatório aparentemente correto com dados inválidos.
  if (metrics.invalidCount > 0) {
    throw new Error(`Integridade do relatório: ${metrics.invalidCount} avaliação(ões) com nota inválida no período ${mesAno}.`);
  }

  const isMulti = plan === 'corporativo' || plan === 'rei';
  const unidades: Unidade[] = isMulti
    ? await db.all(`SELECT id, nome, slug FROM unidades WHERE empresa_id = ? AND ativo = 1 ORDER BY nome`, [empresaId])
    : [];

  const byUnit = new Map<string, ReportReview[]>();
  for (const review of metrics.validReviews) {
    const key = review.unidade_id || '_matriz';
    if (!byUnit.has(key)) byUnit.set(key, []);
    byUnit.get(key)!.push(review);
  }

  const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true, info: { Title: `${empresa.nome_empresa} — Relatório ${mesAno}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const [year, month] = mesAno.split('-');
  const names = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const period = Number(month) >= 1 && Number(month) <= 12 ? `${names[Number(month) - 1]} / ${year}` : mesAno;
  const issued = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' }).format(new Date());

  const watermark = () => {
    const cx = doc.page.width / 2;
    const cy = doc.page.height / 2;
    doc.save();
    doc.opacity(0.03).fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(54);
    doc.rotate(-45, { origin: [cx, cy] });
    doc.text('FILTRA.IA', cx - 180, cy - 30, { width: 360, align: 'center', lineBreak: false });
    doc.restore();
  };
  watermark();
  doc.on('pageAdded', watermark);

  doc.rect(0, 0, doc.page.width, 72).fill(COLORS.navy);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16).text('FILTRA.IA', 42, 22);
  doc.fillColor('#c7d2e5').font('Helvetica').fontSize(9).text(plan === 'rei' ? 'Relatório executivo avançado' : isMulti ? 'Relatório multi-unidades' : 'Relatório mensal', 42, 44);
  doc.y = 90;
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(18).text(empresa.nome_empresa);
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9).text(`Período: ${period}  ·  Emitido em ${issued}  ·  Plano: ${plan.toUpperCase()}`);
  doc.moveDown(0.8);

  section(doc, 'Painel executivo', 'Indicadores consolidados do período');
  const gap = 10;
  const kw = (pageWidth - gap * 2) / 3;
  const ky = doc.y;
  drawKpi(doc, 'Volume', String(metrics.total), 'Avaliações válidas no mês', 42, ky, kw);
  drawKpi(doc, 'Satisfação', metrics.average === null ? '—' : `${formatAverage(metrics.average, 1)} / 5`, 'Média somente de notas 1–5', 42 + kw + gap, ky, kw);
  drawKpi(doc, 'Críticas', String(metrics.critical), 'Notas 1–3', 42 + (kw + gap) * 2, ky, kw);
  doc.y = ky + 96;

  section(doc, 'Distribuição de notas', 'Os cinco grupos somam exatamente o volume válido do período');
  drawDistribution(doc, metrics.distribution, 42, doc.y, pageWidth);
  doc.y += 166;

  drawMix(doc, metrics.positive, metrics.critical, 42, doc.y, pageWidth);
  doc.y += 96;

  if (plan === 'rei') {
    section(doc, 'Indicadores derivados', 'Percentuais calculados exclusivamente sobre avaliações válidas');
    drawKpi(doc, 'Taxa positiva', formatPercent(metrics.positiveRate), 'Notas 4–5 / total', 42, doc.y, kw);
    drawKpi(doc, 'Taxa crítica', formatPercent(metrics.total ? metrics.critical / metrics.total : null), 'Notas 1–3 / total', 42 + kw + gap, doc.y, kw);
    drawKpi(doc, 'Integridade', '100%', 'Métricas fechadas e validadas', 42 + (kw + gap) * 2, doc.y, kw);
    doc.y += 96;
  }

  if (isMulti) {
    if (doc.y > 520) doc.addPage();
    section(doc, 'Ranking de unidades', 'Média e volume calculados separadamente por unidade');
    const map = new Map(unidades.map((u) => [u.id, u]));
    const groups = [...byUnit.entries()].map(([key, reviews]) => ({
      nome: key === '_matriz' ? 'Matriz / Geral' : (map.get(key)?.nome || key),
      metrics: unidadeMetrics(reviews),
    })).sort((a, b) => (b.metrics.average ?? -1) - (a.metrics.average ?? -1));

    const tableY = doc.y;
    const rowH = 20;
    doc.roundedRect(42, tableY, pageWidth, 28 + groups.length * rowH, 6).fillAndStroke('#ffffff', COLORS.line);
    doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(7.5);
    doc.text('UNIDADE', 54, tableY + 7, { width: 180 });
    doc.text('VOLUME', 250, tableY + 7, { width: 60 });
    doc.text('MÉDIA', 320, tableY + 7, { width: 50 });
    doc.text('CRÍTICAS', 380, tableY + 7, { width: 60 });
    doc.text('POSITIVAS', 450, tableY + 7, { width: 60 });
    groups.forEach((group, i) => {
      assertReportConsistency(group.metrics);
      const y = tableY + 28 + i * rowH;
      doc.fillColor(COLORS.ink).font('Helvetica').fontSize(8);
      doc.text(group.nome.slice(0, 32), 54, y, { width: 180 });
      doc.text(String(group.metrics.total), 250, y, { width: 60 });
      doc.text(formatAverage(group.metrics.average), 320, y, { width: 50 });
      doc.text(String(group.metrics.critical), 380, y, { width: 60 });
      doc.text(String(group.metrics.positive), 450, y, { width: 60 });
    });
    doc.y = tableY + 42 + groups.length * rowH;
  }

  if (doc.y > 680) doc.addPage();
  section(doc, 'Recomendação estratégica', 'Orientação baseada somente nos indicadores calculados');
  const recommendation = metrics.total === 0
    ? 'Ainda não há avaliações válidas neste período. Divulgue o link ou QR Code para iniciar a coleta.'
    : metrics.critical > metrics.positive
      ? 'O volume de críticas está acima das avaliações positivas. Priorize os pontos de atrito antes de ampliar a captação.'
      : 'O fluxo está saudável. Mantenha a coleta ativa e acompanhe unidades ou períodos abaixo da média.';
  const ry = doc.y;
  doc.roundedRect(42, ry, pageWidth, 68, 6).fillAndStroke(COLORS.paleBlue, COLORS.line);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(9).text('Orientação', 56, ry + 12);
  doc.fillColor(COLORS.ink).font('Helvetica').fontSize(9).text(recommendation, 56, ry + 28, { width: pageWidth - 28, lineGap: 2 });

  await new Promise<void>((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fillColor(COLORS.muted).fontSize(7).font('Helvetica').text(`© FILTRA.IA — uso exclusivo de ${empresa.nome_empresa}  ·  p. ${i - range.start + 1}/${range.count}`, 42, doc.page.height - 36, { width: pageWidth, align: 'center' });
    }
    doc.end();
  });

  return Buffer.concat(chunks);
}
