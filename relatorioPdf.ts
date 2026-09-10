/**
 * Relatório mensal em PDF — profundidade progressiva por plano.
 *
 * Pro ............ relatório mensal + KPIs + distribuição
 * Ultra .......... + análise de desempenho e leitura avançada
 * Corporativo .... + visão multi-unidades + ranking + detalhes por unidade
 * Rei ............ + tudo do Corporativo com apresentação executiva ampliada
 *
 * O PDF respeita planTemPdf: Inicial não possui relatório mensal.
 * A rota atual não passa callGroq, portanto este arquivo não promete IA que não
 * esteja disponível nos dados recebidos. Quando callGroq é fornecido, a análise
 * textual é enriquecida de forma opcional.
 */
import type { Database } from 'sqlite';
import PDFDocument from 'pdfkit';

export type PlanPdf = 'ultra' | 'corporativo' | 'rei' | 'pro';

type ReviewRow = {
  rating: number;
  comment?: string | null;
  unidade_id?: string | null;
  origin?: string | null;
  createdAt?: string;
};

type UnidadeRow = {
  id: string;
  nome: string;
  slug?: string | null;
};

type CallGroq = (system: string, user: string) => Promise<string>;

type UnitGroup = {
  unidade: UnidadeRow | { id: string; nome: string };
  reviews: ReviewRow[];
};

const COLORS = {
  navy: '#17233c',
  blue: '#2d5b9f',
  ink: '#26364d',
  muted: '#65748a',
  line: '#d9e1eb',
  pale: '#f5f7fa',
  paleBlue: '#edf3fa',
  blueSoft: '#e8f0fa',
  green: '#1a7f4b',
  amber: '#b45309',
  red: '#b91c1c',
  white: '#ffffff',
  star: ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'],
};

const PAGE = { left: 42, right: 42, top: 42, bottom: 48 };

// ─── Schema filiais / origem ─────────────────────────────────────────

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

// ─── Métricas ────────────────────────────────────────────────────────

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

function agrupadoPorUnidade(reviews: ReviewRow[], unidades: UnidadeRow[]): UnitGroup[] {
  const map = new Map<string, ReviewRow[]>();
  for (const review of reviews) {
    const key = review.unidade_id || review.origin || '_matriz';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(review);
  }

  const byId = new Map(unidades.map((u) => [u.id, u]));
  const groups: UnitGroup[] = [];

  for (const [key, list] of map.entries()) {
    if (byId.has(key)) groups.push({ unidade: byId.get(key)!, reviews: list });
    else if (key === '_matriz') groups.push({ unidade: { id: key, nome: 'Matriz / Geral' }, reviews: list });
    else groups.push({ unidade: { id: key, nome: key }, reviews: list });
  }

  for (const unidade of unidades) {
    if (!map.has(unidade.id)) groups.push({ unidade, reviews: [] });
  }

  return groups.sort((a, b) => {
    const averageDiff = media(b.reviews) - media(a.reviews);
    return averageDiff || b.reviews.length - a.reviews.length;
  });
}

// ─── Layout ──────────────────────────────────────────────────────────

function sectionTitle(doc: PDFKit.PDFDocument, title: string, subtitle?: string) {
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(13).text(title);
  if (subtitle) {
    doc.moveDown(0.15);
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8.5).text(subtitle);
  }
  doc.moveDown(0.5);
}

function drawKpi(
  doc: PDFKit.PDFDocument,
  title: string,
  value: string,
  desc: string,
  x: number,
  y: number,
  width: number,
  accent = COLORS.blue
) {
  doc.roundedRect(x, y, width, 78, 7).fillAndStroke(COLORS.pale, COLORS.line);
  doc.roundedRect(x, y, 4, 78, 2).fill(accent);
  doc.fillColor(COLORS.blue).font('Helvetica-Bold').fontSize(7.5).text(title.toUpperCase(), x + 12, y + 10, {
    width: width - 20,
  });
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(18).text(value, x + 12, y + 28, {
    width: width - 20,
  });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5).text(desc, x + 12, y + 52, {
    width: width - 20,
  });
}

function drawHeader(doc: PDFKit.PDFDocument, empresaNome: string, periodo: string, plan: string, subtitle: string) {
  doc.rect(0, 0, doc.page.width, 78).fill(COLORS.navy);
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(17).text('FILTRA.AI', PAGE.left, 20);
  doc.fillColor('#c7d2e5').font('Helvetica').fontSize(8.5).text(subtitle, PAGE.left, 45);
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(8).text(plan.toUpperCase(), doc.page.width - 132, 23, {
    width: 90,
    align: 'right',
  });
  doc.fillColor('#c7d2e5').font('Helvetica').fontSize(7.5).text(periodo, doc.page.width - 132, 40, {
    width: 90,
    align: 'right',
  });
  doc.y = 98;
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(18).text(empresaNome, PAGE.left, doc.y);
  doc.moveDown(0.15);
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8).text(`Período analisado: ${periodo}`);
  doc.moveDown(0.8);
}

function drawFooter(doc: PDFKit.PDFDocument, empresaNome: string, page: number, total: number) {
  const y = doc.page.height - 30;
  doc.strokeColor(COLORS.line).lineWidth(0.5).moveTo(PAGE.left, y - 8).lineTo(doc.page.width - PAGE.right, y - 8).stroke();
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7).text(
    `© FILTRA.AI · uso exclusivo de ${empresaNome}`,
    PAGE.left,
    y,
    { width: 280 }
  );
  doc.text(`Página ${page}/${total}`, doc.page.width - PAGE.right - 80, y, { width: 80, align: 'right' });
}

function drawWatermark(doc: PDFKit.PDFDocument) {
  const cx = doc.page.width / 2;
  const cy = doc.page.height / 2;
  doc.save();
  doc.opacity(0.025);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(42);
  doc.rotate(-45, { origin: [cx, cy] });
  doc.text('FILTRA.AI', cx - 135, cy - 18, { width: 270, align: 'center', lineBreak: false });
  doc.restore();
}

function newPage(doc: PDFKit.PDFDocument, empresaNome: string, periodo: string, plan: string, subtitle: string) {
  doc.addPage();
  drawHeader(doc, empresaNome, periodo, plan, subtitle);
}

function drawBarChart(
  doc: PDFKit.PDFDocument,
  opts: { x: number; y: number; width: number; height: number; labels: string[]; values: number[]; title: string }
) {
  const { x, y, width, height, labels, values, title } = opts;
  const max = Math.max(...values, 1);
  const gap = 10;
  const barW = (width - gap * (values.length + 1)) / values.length;
  const top = y + 28;
  const chartH = height - 50;

  doc.roundedRect(x, y, width, height, 7).fillAndStroke(COLORS.white, COLORS.line);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(9).text(title, x + 12, y + 10);

  for (let i = 0; i <= 4; i++) {
    const gy = top + chartH - (chartH * i) / 4;
    doc.strokeColor(COLORS.line).lineWidth(0.5).moveTo(x + 10, gy).lineTo(x + width - 10, gy).stroke();
  }

  values.forEach((value, index) => {
    const barH = (value / max) * chartH;
    const bx = x + gap + index * (barW + gap);
    const by = top + chartH - barH;
    doc.roundedRect(bx, by, barW, Math.max(barH, 1), 4).fill(COLORS.star[index] || COLORS.blue);
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8).text(String(value), bx, by - 12, {
      width: barW,
      align: 'center',
    });
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5).text(labels[index], bx, top + chartH + 5, {
      width: barW,
      align: 'center',
    });
  });
}

function drawDonut(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  size: number,
  positive: number,
  negative: number,
  title: string
) {
  const total = Math.max(positive + negative, 1);
  const cx = x + size / 2;
  const cy = y + size / 2 + 10;
  const radius = size / 2 - 8;
  const positiveAngle = (positive / total) * Math.PI * 2;

  doc.roundedRect(x, y, size + 22, size + 42, 7).fillAndStroke(COLORS.white, COLORS.line);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(8.5).text(title, x + 9, y + 8);

  const slices = 64;
  for (let i = 0; i < slices; i++) {
    const a0 = -Math.PI / 2 + (i / slices) * Math.PI * 2;
    const a1 = -Math.PI / 2 + ((i + 1) / slices) * Math.PI * 2;
    const fromTop = ((i + 0.5) / slices) * Math.PI * 2;
    const color = fromTop <= positiveAngle ? COLORS.green : COLORS.red;
    doc.moveTo(cx, cy)
      .lineTo(cx + Math.cos(a0) * radius, cy + Math.sin(a0) * radius)
      .lineTo(cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius)
      .closePath()
      .fill(color);
  }
  doc.circle(cx, cy, radius * 0.55).fill(COLORS.white);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(13).text(percent(positive, total), cx - 25, cy - 8, {
    width: 50,
    align: 'center',
  });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7).text('positivas', cx - 28, cy + 8, {
    width: 56,
    align: 'center',
  });
}

function drawMetricList(doc: PDFKit.PDFDocument, x: number, y: number, width: number, rows: { label: string; value: string }[]) {
  const height = 36 + rows.length * 25;
  doc.roundedRect(x, y, width, height, 7).fillAndStroke(COLORS.white, COLORS.line);
  rows.forEach((row, i) => {
    const ry = y + 16 + i * 25;
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8).text(row.label, x + 12, ry, { width: width - 100 });
    doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(8.5).text(row.value, x + width - 88, ry, {
      width: 76,
      align: 'right',
    });
    if (i < rows.length - 1) {
      doc.strokeColor(COLORS.line).lineWidth(0.5).moveTo(x + 12, ry + 16).lineTo(x + width - 12, ry + 16).stroke();
    }
  });
  return height;
}

function drawInsightBox(doc: PDFKit.PDFDocument, x: number, y: number, width: number, title: string, text: string, accent = COLORS.blue) {
  const height = 76;
  doc.roundedRect(x, y, width, height, 7).fillAndStroke(COLORS.paleBlue, COLORS.line);
  doc.roundedRect(x, y, 4, height, 2).fill(accent);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(9).text(title, x + 14, y + 11);
  doc.fillColor(COLORS.ink).font('Helvetica').fontSize(8.5).text(text, x + 14, y + 29, {
    width: width - 28,
    lineGap: 2,
  });
  return height;
}

function drawUnitTable(doc: PDFKit.PDFDocument, x: number, y: number, width: number, groups: UnitGroup[]) {
  const headerH = 26;
  const rowH = 24;
  const maxRows = Math.max(groups.length, 1);
  const height = headerH + maxRows * rowH;
  doc.roundedRect(x, y, width, height, 7).fillAndStroke(COLORS.white, COLORS.line);
  doc.rect(x, y, width, headerH).fill(COLORS.pale);

  doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(7.5);
  doc.text('UNIDADE', x + 12, y + 8, { width: 175 });
  doc.text('VOLUME', x + 205, y + 8, { width: 50, align: 'right' });
  doc.text('MÉDIA', x + 270, y + 8, { width: 50, align: 'right' });
  doc.text('1–3★', x + 335, y + 8, { width: 50, align: 'right' });
  doc.text('4–5★', x + 405, y + 8, { width: 50, align: 'right' });

  groups.forEach((group, i) => {
    const ry = y + headerH + i * rowH;
    const negative = group.reviews.filter((r) => r.rating <= 3).length;
    const positive = group.reviews.filter((r) => r.rating >= 4).length;
    if (i % 2 === 1) doc.rect(x + 1, ry, width - 2, rowH).fill('#fbfcfe');
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(8).text(group.unidade.nome.slice(0, 31), x + 12, ry + 8, { width: 175 });
    doc.text(String(group.reviews.length), x + 205, ry + 8, { width: 50, align: 'right' });
    doc.text(media(group.reviews) ? media(group.reviews).toFixed(2) : '—', x + 270, ry + 8, { width: 50, align: 'right' });
    doc.fillColor(negative ? COLORS.red : COLORS.muted).text(String(negative), x + 335, ry + 8, { width: 50, align: 'right' });
    doc.fillColor(positive ? COLORS.green : COLORS.muted).text(String(positive), x + 405, ry + 8, { width: 50, align: 'right' });
  });
}

function paginaFilial(
  doc: PDFKit.PDFDocument,
  opts: { empresaNome: string; periodo: string; unidadeNome: string; reviews: ReviewRow[]; pageWidth: number; plan: string }
) {
  const { empresaNome, periodo, unidadeNome, reviews, pageWidth, plan } = opts;
  const dist = distNotas(reviews);
  const avg = media(reviews);
  const positive = reviews.filter((r) => r.rating >= 4).length;
  const negative = reviews.filter((r) => r.rating <= 3).length;

  newPage(doc, empresaNome, periodo, plan, 'Demonstrativo detalhado por unidade');
  sectionTitle(doc, unidadeNome, 'Desempenho da unidade no período selecionado');

  const gap = 10;
  const width = (pageWidth - gap * 2) / 3;
  const y = doc.y;
  drawKpi(doc, 'Avaliações', String(reviews.length), 'Volume no período', 42, y, width);
  drawKpi(doc, 'Nota média', avg ? avg.toFixed(2) : '—', 'Escala de 1 a 5', 42 + width + gap, y, width, avg >= 4 ? COLORS.green : COLORS.amber);
  drawKpi(doc, 'Taxa positiva', percent(positive, reviews.length), 'Notas 4–5', 42 + (width + gap) * 2, y, width, COLORS.green);
  doc.y = y + 96;

  drawBarChart(doc, {
    x: 42,
    y: doc.y,
    width: pageWidth,
    height: 158,
    labels: ['1★', '2★', '3★', '4★', '5★'],
    values: dist,
    title: 'Distribuição das avaliações',
  });
  doc.y += 176;

  const insight =
    reviews.length === 0
      ? 'Não houve avaliações associadas a esta unidade no período. Use este indicador para verificar a coleta e a ativação do canal de feedback.'
      : negative > positive
        ? 'A unidade apresenta mais avaliações críticas do que positivas. Priorize os motivos recorrentes nas notas 1–3 e acompanhe a evolução no próximo período.'
        : 'A unidade mantém predominância de avaliações positivas. Preserve os pontos fortes e monitore as avaliações 1–3 para evitar deterioração da média.';
  drawInsightBox(doc, 42, doc.y, pageWidth, 'Leitura operacional', insight, negative > positive ? COLORS.red : COLORS.green);

  if (plan === 'rei') {
    doc.y += 94;
    const rows = [
      { label: 'Avaliações positivas', value: String(positive) },
      { label: 'Avaliações críticas', value: String(negative) },
      { label: 'Participação positiva', value: percent(positive, reviews.length) },
      { label: 'Participação crítica', value: percent(negative, reviews.length) },
    ];
    drawMetricList(doc, 42, doc.y, pageWidth, rows);
  }
}

// ─── Geração principal ───────────────────────────────────────────────

export async function gerarRelatorioMensalPDF(
  db: Database,
  empresaId: string,
  mesAno: string,
  callGroq?: CallGroq
): Promise<Buffer> {
  await ensureUnidadesSchema(db);

  const empresa = await db.get('SELECT * FROM empresas WHERE id = ?', [empresaId]);
  if (!empresa) throw new Error('Empresa não encontrada.');

  const plan = String(empresa.plan || '').toLowerCase();
  const elegivel = ['pro', 'ultra', 'corporativo', 'rei'].includes(plan);
  if (!elegivel) throw new Error('Plano não elegível para relatório mensal.');

  const isUltraPlus = ['ultra', 'corporativo', 'rei'].includes(plan);
  const isMultiUnit = ['corporativo', 'rei'].includes(plan);
  const isRei = plan === 'rei';
  const reportSubtitle = isRei
    ? 'Relatório executivo avançado'
    : isMultiUnit
      ? 'Relatório executivo multi-unidades'
      : isUltraPlus
        ? 'Relatório mensal com análise de desempenho'
        : 'Relatório mensal';

  const reviews: ReviewRow[] = await db.all(
    `SELECT rating, comment, unidade_id, origin, createdAt FROM reviews
     WHERE empresa_id = ? AND strftime('%Y-%m', createdAt) = ?`,
    [empresaId, mesAno]
  );

  const unidades: UnidadeRow[] = isMultiUnit
    ? await db.all(
        `SELECT id, nome, slug FROM unidades WHERE empresa_id = ? AND ativo = 1 ORDER BY nome`,
        [empresaId]
      )
    : [];

  const groups = isMultiUnit ? agrupadoPorUnidade(reviews, unidades) : [];
  const dist = distNotas(reviews);
  const total = reviews.length;
  const avg = media(reviews);
  const positive = reviews.filter((r) => r.rating >= 4).length;
  const negative = reviews.filter((r) => r.rating <= 3).length;

  let sentimentoPrincipal = '';
  let topGargalos: string[] = [];
  if (callGroq && reviews.some((r) => r.comment?.trim())) {
    const comentarios = reviews.map((r) => r.comment?.trim()).filter(Boolean).slice(0, 80).join('\n');
    try {
      const raw = await callGroq(
        `Você é um analista de experiência do cliente. Retorne JSON válido com "sentimento" (positivo, negativo ou neutro) e "gargalos" (até 5 tópicos curtos).`,
        comentarios
      );
      const parsed = JSON.parse(raw);
      sentimentoPrincipal = String(parsed.sentimento || '');
      topGargalos = Array.isArray(parsed.gargalos) ? parsed.gargalos.map(String).slice(0, 5) : [];
    } catch {
      sentimentoPrincipal = '';
      topGargalos = [];
    }
  }

  const [year, month] = mesAno.split('-');
  const months = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const periodo = year && Number(month) >= 1 && Number(month) <= 12 ? `${months[Number(month) - 1]} / ${year}` : mesAno;
  const emissao = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' }).format(new Date());

  const doc = new PDFDocument({
    size: 'A4',
    margin: PAGE.left,
    bufferPages: true,
    info: {
      Title: `${empresa.nome_empresa} — Relatório ${mesAno}`,
      Author: 'Filtra.AI',
      Subject: `Relatório mensal — ${plan}`,
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  const pageWidth = doc.page.width - PAGE.left - PAGE.right;

  // Capa: mais limpa e mais profissional para todos os planos.
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(COLORS.white);
  doc.rect(0, 0, doc.page.width, 130).fill(COLORS.navy);
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(25).text('FILTRA.AI', 42, 40);
  doc.fillColor('#c7d2e5').font('Helvetica').fontSize(10).text(reportSubtitle, 42, 78);
  doc.fillColor(COLORS.blue).font('Helvetica-Bold').fontSize(9).text(plan.toUpperCase(), 42, 105);

  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(25).text(empresa.nome_empresa, 42, 195, { width: pageWidth });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(12).text(`Relatório de reputação · ${periodo}`, 42, 232);
  doc.moveTo(42, 265).lineTo(160, 265).strokeColor(COLORS.blue).lineWidth(3).stroke();

  const coverY = 320;
  drawKpi(doc, 'Avaliações', String(total), 'Volume analisado', 42, coverY, 150);
  drawKpi(doc, 'Nota média', avg ? avg.toFixed(2) : '—', 'Escala de 1 a 5', 208, coverY, 150, avg >= 4 ? COLORS.green : COLORS.amber);
  drawKpi(doc, 'Taxa positiva', percent(positive, total), 'Notas 4–5', 374, coverY, 150, COLORS.green);

  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9).text(`Emitido em ${emissao}`, 42, 440);
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8.5).text('Documento gerado pelo Filtra.AI a partir das avaliações registradas no período.', 42, 466, {
    width: pageWidth,
  });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5).text('Este relatório apresenta indicadores operacionais e não substitui análise gerencial.', 42, doc.page.height - 64, {
    width: pageWidth,
  });

  // Página executiva / KPIs.
  newPage(doc, empresa.nome_empresa, periodo, plan, reportSubtitle);
  sectionTitle(doc, 'Resumo executivo', 'Visão consolidada do desempenho de reputação no período');

  const gap = 10;
  const kw = (pageWidth - gap * 2) / 3;
  const kY = doc.y;
  drawKpi(doc, 'Volume', String(total), 'Avaliações no mês', 42, kY, kw);
  drawKpi(doc, 'Nota média', avg ? avg.toFixed(2) : '—', 'Escala de 1 a 5', 42 + kw + gap, kY, kw, avg >= 4 ? COLORS.green : COLORS.amber);
  drawKpi(doc, 'Críticas', String(negative), 'Notas 1–3', 42 + (kw + gap) * 2, kY, kw, negative ? COLORS.red : COLORS.green);
  doc.y = kY + 96;

  const donutY = doc.y;
  drawDonut(doc, 42, donutY, 135, positive, negative, 'Mix de avaliações');
  drawMetricList(doc, 205, donutY, pageWidth - 163, [
    { label: 'Avaliações positivas (4–5)', value: String(positive) },
    { label: 'Avaliações críticas (1–3)', value: String(negative) },
    { label: 'Participação positiva', value: percent(positive, total) },
    { label: 'Participação crítica', value: percent(negative, total) },
    { label: 'Nota média', value: avg ? `${avg.toFixed(2)} / 5` : '—' },
  ]);
  doc.y = donutY + 190;

  const executiveReading =
    total === 0
      ? 'Não houve avaliações no período. Antes de comparar desempenho, confirme que o canal de coleta está ativo e sendo utilizado.'
      : avg >= 4.5
        ? 'O desempenho consolidado está em patamar forte. Preserve os pontos positivos e mantenha atenção às avaliações 1–3.'
        : avg >= 4
          ? 'O desempenho consolidado é saudável, mas existe espaço para elevar a média trabalhando os motivos presentes nas avaliações críticas.'
          : 'O período apresenta sinal de atenção. Priorize as avaliações 1–3, identifique causas recorrentes e acompanhe a evolução mês a mês.';
  drawInsightBox(doc, 42, doc.y, pageWidth, 'Leitura do período', executiveReading, avg >= 4 ? COLORS.green : COLORS.red);

  // Distribuição de estrelas.
  newPage(doc, empresa.nome_empresa, periodo, plan, reportSubtitle);
  sectionTitle(doc, 'Distribuição de notas', 'Detalhamento do volume por estrela');
  drawBarChart(doc, {
    x: 42,
    y: doc.y,
    width: pageWidth,
    height: 205,
    labels: ['1★', '2★', '3★', '4★', '5★'],
    values: dist,
    title: 'Quantidade de avaliações por nota',
  });
  doc.y += 225;

  const starRows = dist.map((value, i) => ({
    label: `${i + 1} estrela${i === 0 ? '' : 's'}`,
    value: `${value} · ${percent(value, total)}`,
  }));
  drawMetricList(doc, 42, doc.y, pageWidth, starRows);

  // Ultra+ recebe uma página de análise de desempenho. Não inventa IA quando ela não foi fornecida.
  if (isUltraPlus) {
    newPage(doc, empresa.nome_empresa, periodo, plan, reportSubtitle);
    sectionTitle(doc, 'Análise de desempenho', 'Indicadores derivados das avaliações registradas');

    const analysisY = doc.y;
    drawKpi(doc, 'Positivas', String(positive), percent(positive, total), 42, analysisY, kw, COLORS.green);
    drawKpi(doc, 'Críticas', String(negative), percent(negative, total), 42 + kw + gap, analysisY, kw, COLORS.red);
    drawKpi(doc, 'Índice médio', avg ? `${avg.toFixed(2)}` : '—', 'Pontuação consolidada', 42 + (kw + gap) * 2, analysisY, kw, COLORS.blue);
    doc.y = analysisY + 100;

    const trendText = avg >= 4.5
      ? 'A distribuição atual indica forte concentração de avaliações positivas. O principal cuidado é não perder qualidade nas notas 1–3.'
      : avg >= 4
        ? 'A distribuição indica uma operação saudável, com oportunidade de reduzir a participação das notas 1–3 e elevar a média.'
        : 'A distribuição mostra necessidade de atuação. Use as avaliações críticas como ponto de partida para correções operacionais.';
    drawInsightBox(doc, 42, doc.y, pageWidth, 'Interpretação', trendText, avg >= 4 ? COLORS.green : COLORS.red);
    doc.y += 94;

    if (sentimentoPrincipal || topGargalos.length) {
      drawInsightBox(
        doc,
        42,
        doc.y,
        pageWidth,
        'Leitura de comentários',
        `${sentimentoPrincipal ? `Sentimento predominante: ${sentimentoPrincipal}. ` : ''}${topGargalos.length ? `Pontos recorrentes: ${topGargalos.join(', ')}.` : ''}`,
        COLORS.blue
      );
    } else {
      drawInsightBox(
        doc,
        42,
        doc.y,
        pageWidth,
        'Comentários',
        'A análise textual por IA fica disponível quando o gerador recebe um provedor de IA. Esta emissão utiliza somente os indicadores registrados, sem consumir tokens de IA.',
        COLORS.blue
      );
    }
  }

  // Corporativo e Rei: página própria para visão multi-unidades.
  if (isMultiUnit) {
    newPage(doc, empresa.nome_empresa, periodo, plan, reportSubtitle);
    sectionTitle(doc, 'Visão multi-unidades', 'Comparação consolidada entre matriz e unidades ativas');

    const unitCount = unidades.length;
    const groupsCount = groups.length;
    const unitY = doc.y;
    drawKpi(doc, 'Unidades ativas', String(unitCount), 'Cadastro do período', 42, unitY, kw);
    drawKpi(doc, 'Unidades com avaliações', String(groups.filter((g) => g.reviews.length).length), 'Com volume registrado', 42 + kw + gap, unitY, kw, COLORS.green);
    drawKpi(doc, 'Média consolidada', avg ? avg.toFixed(2) : '—', 'Todas as unidades', 42 + (kw + gap) * 2, unitY, kw, avg >= 4 ? COLORS.green : COLORS.amber);
    doc.y = unitY + 100;

    drawUnitTable(doc, 42, doc.y, pageWidth, groups);
    doc.y += 35 + Math.max(groups.length, 1) * 24;

    const rankingReading = groups.length
      ? `A tabela permite identificar rapidamente unidades com maior e menor média. Em caso de empate, o volume de avaliações ajuda a priorizar a leitura.`
      : 'Ainda não existem unidades ou avaliações suficientes para formar um ranking.';
    drawInsightBox(doc, 42, doc.y, pageWidth, 'Como ler o ranking', rankingReading, COLORS.blue);

    // Cada unidade recebe uma página própria para tornar o relatório realmente útil para gestão.
    for (const group of groups) {
      paginaFilial(doc, {
        empresaNome: empresa.nome_empresa,
        periodo,
        unidadeNome: group.unidade.nome,
        reviews: group.reviews,
        pageWidth,
        plan,
      });
    }
  }

  // Rei: fechamento executivo adicional, sem criar um benefício comercial novo.
  if (isRei) {
    newPage(doc, empresa.nome_empresa, periodo, plan, reportSubtitle);
    sectionTitle(doc, 'Fechamento executivo', 'Síntese para acompanhamento gerencial');

    const closing = avg >= 4.5
      ? 'O período termina com desempenho muito positivo. Mantenha a disciplina operacional e acompanhe as críticas individualmente.'
      : avg >= 4
        ? 'O período apresenta desempenho saudável. O próximo ganho relevante tende a vir da redução das notas 1–3.'
        : 'O período exige atenção gerencial. Concentre esforços nas causas das avaliações críticas e monitore a recuperação da média.';
    drawInsightBox(doc, 42, doc.y, pageWidth, 'Prioridade recomendada', closing, avg >= 4 ? COLORS.green : COLORS.red);
    doc.y += 96;

    const priorityRows = [
      { label: 'Nota média', value: avg ? `${avg.toFixed(2)} / 5` : '—' },
      { label: 'Taxa positiva', value: percent(positive, total) },
      { label: 'Taxa crítica', value: percent(negative, total) },
      { label: 'Avaliações no período', value: String(total) },
      { label: 'Unidades ativas', value: String(unidades.length) },
    ];
    drawMetricList(doc, 42, doc.y, pageWidth, priorityRows);
    doc.y += 190;

    drawInsightBox(
      doc,
      42,
      doc.y,
      pageWidth,
      'Nota metodológica',
      'Os indicadores deste relatório são calculados diretamente sobre as avaliações registradas para o período selecionado. A classificação de crítica considera notas de 1 a 3 estrelas.',
      COLORS.blue
    );
  }

  // Recomendação final comum a todos os relatórios elegíveis.
  newPage(doc, empresa.nome_empresa, periodo, plan, reportSubtitle);
  sectionTitle(doc, 'Próximos passos', 'Orientação operacional baseada nos indicadores do período');

  const recommendations = [
    total === 0
      ? 'Ative e divulgue o canal de coleta de feedback para começar a construir histórico.'
      : negative > positive
        ? 'Priorize as avaliações 1–3 e transforme os motivos recorrentes em ações operacionais mensuráveis.'
        : 'Mantenha o processo de coleta ativo e acompanhe de perto as avaliações 1–3.',
    isMultiUnit
      ? 'Compare as unidades abaixo da média consolidada com as unidades de melhor desempenho e replique boas práticas.'
      : 'Use a evolução mensal da nota média para medir o efeito das ações realizadas.',
    'Revise o próximo relatório com o mesmo período de referência para evitar comparações distorcidas.',
  ];

  recommendations.forEach((text, index) => {
    const y = doc.y;
    doc.circle(53, y + 7, 8).fill(index === 0 ? COLORS.blue : COLORS.paleBlue);
    doc.fillColor(index === 0 ? COLORS.white : COLORS.blue).font('Helvetica-Bold').fontSize(7.5).text(String(index + 1), 50, y + 4, {
      width: 6,
      align: 'center',
    });
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(9).text(text, 72, y, { width: pageWidth - 30, lineGap: 2 });
    doc.y = y + 58;
  });

  drawInsightBox(
    doc,
    42,
    doc.y + 10,
    pageWidth,
    'Escopo do relatório',
    isRei
      ? 'Este relatório consolida os indicadores do plano REI e sua visão multi-unidades, mantendo a mesma base de benefícios comerciais do plano Corporativo e uma apresentação executiva mais ampla.'
      : isMultiUnit
        ? 'Este relatório utiliza a capacidade multi-unidades do plano para apresentar visão consolidada e detalhamento por unidade.'
        : plan === 'ultra'
          ? 'Este relatório amplia a visão do plano Ultra com indicadores de análise de desempenho.'
          : 'Este relatório apresenta os indicadores mensais disponíveis para o plano Pro.',
    COLORS.blue
  );

  // Watermark e rodapé somente depois de todas as páginas existirem. Isso evita cortes
  // e garante que o watermark fique discreto e centralizado em cada página.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    drawWatermark(doc);
    drawFooter(doc, empresa.nome_empresa, i - range.start + 1, range.count);
  }

  return await new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
