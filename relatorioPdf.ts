/**
 * Relatório mensal em PDF — gráficos e profundidade por plano
 *
 * Ultra ........ gráficos simples (distribuição de notas + KPIs)
 * Corporativo .. + ranking de filiais + 1 página por filial
 * Rei .......... gráficos elaborados + filiais + tags + sentimento detalhado
 */
import type { Database } from 'sqlite';
import PDFDocument from 'pdfkit';
import { honestNoteForRating } from './lib/notes';

// ─── Tipos ───────────────────────────────────────────────────────────

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
  if (!cols.includes('unidade_id')) {
    await db.exec(`ALTER TABLE reviews ADD COLUMN unidade_id TEXT`);
  }
  if (!cols.includes('origin')) {
    await db.exec(`ALTER TABLE reviews ADD COLUMN origin TEXT`);
  }
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
  return reviews.reduce((s, r) => s + Number(r.rating || 0), 0) / reviews.length;
}

function agrupadoPorUnidade(
  reviews: ReviewRow[],
  unidades: UnidadeRow[]
): { unidade: UnidadeRow | { id: string; nome: string }; reviews: ReviewRow[] }[] {
  const map = new Map<string, ReviewRow[]>();
  for (const r of reviews) {
    const key = r.unidade_id || r.origin || '_matriz';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }

  const byId = new Map(unidades.map((u) => [u.id, u]));
  const out: { unidade: UnidadeRow | { id: string; nome: string }; reviews: ReviewRow[] }[] = [];

  for (const [key, list] of map.entries()) {
    if (byId.has(key)) {
      out.push({ unidade: byId.get(key)!, reviews: list });
    } else if (key === '_matriz') {
      out.push({ unidade: { id: '_matriz', nome: 'Matriz / Geral' }, reviews: list });
    } else {
      out.push({ unidade: { id: key, nome: key }, reviews: list });
    }
  }

  for (const u of unidades) {
    if (!map.has(u.id)) out.push({ unidade: u, reviews: [] });
  }

  return out.sort((a, b) => media(b.reviews) - media(a.reviews));
}

// ─── Desenho de gráficos (PDFKit nativo) ──────────────────────────────

const COLORS = {
  navy: '#17233c',
  blue: '#2d5b9f',
  ink: '#26364d',
  muted: '#65748a',
  line: '#d9e1eb',
  pale: '#f5f7fa',
  paleBlue: '#edf3fa',
  green: '#1a7f4b',
  amber: '#b45309',
  red: '#b91c1c',
  star: ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'],
};

function drawBarChart(
  doc: PDFKit.PDFDocument,
  opts: {
    x: number;
    y: number;
    width: number;
    height: number;
    labels: string[];
    values: number[];
    title: string;
    colors?: string[];
    showValues?: boolean;
  }
) {
  const { x, y, width, height, labels, values, title } = opts;
  const colors = opts.colors || labels.map((_, i) => COLORS.star[i % COLORS.star.length]);
  const max = Math.max(...values, 1);
  const gap = 8;
  const barW = (width - gap * (values.length + 1)) / values.length;
  const chartTop = y + 22;
  const chartH = height - 40;

  doc.roundedRect(x, y, width, height, 6).fillAndStroke('#ffffff', COLORS.line);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(9).text(title, x + 12, y + 8, {
    width: width - 24,
  });

  for (let i = 0; i <= 4; i++) {
    const gy = chartTop + chartH - (chartH * i) / 4;
    doc
      .moveTo(x + 8, gy)
      .lineTo(x + width - 8, gy)
      .strokeColor(COLORS.line)
      .lineWidth(0.5)
      .stroke();
  }

  values.forEach((v, i) => {
    const bh = (v / max) * chartH;
    const bx = x + gap + i * (barW + gap);
    const by = chartTop + chartH - bh;
    doc.roundedRect(bx, by, barW, Math.max(bh, 1), 3).fill(colors[i]);
    if (opts.showValues !== false) {
      doc
        .fillColor(COLORS.ink)
        .font('Helvetica-Bold')
        .fontSize(8)
        .text(String(v), bx, by - 12, { width: barW, align: 'center' });
    }
    doc
      .fillColor(COLORS.muted)
      .font('Helvetica')
      .fontSize(7.5)
      .text(labels[i], bx, chartTop + chartH + 4, { width: barW, align: 'center' });
  });
}

function drawHorizontalBars(
  doc: PDFKit.PDFDocument,
  opts: {
    x: number;
    y: number;
    width: number;
    title: string;
    items: { label: string; value: number }[];
    color?: string;
  }
): number {
  const { x, y, width, title, items } = opts;
  const color = opts.color || COLORS.blue;
  const rowH = 22;
  const height = 28 + items.length * rowH + 8;
  const max = Math.max(...items.map((i) => i.value), 1);
  const barMax = width - 140;

  doc.roundedRect(x, y, width, height, 6).fillAndStroke('#ffffff', COLORS.line);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(9).text(title, x + 12, y + 8);

  items.forEach((it, i) => {
    const ry = y + 26 + i * rowH;
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(8).text(it.label.slice(0, 28), x + 12, ry + 4, {
      width: 100,
    });
    const bw = (it.value / max) * barMax;
    doc.roundedRect(x + 118, ry + 2, Math.max(bw, 2), 12, 3).fill(color);
    doc
      .fillColor(COLORS.muted)
      .font('Helvetica')
      .fontSize(8)
      .text(String(it.value), x + 118 + bw + 6, ry + 3);
  });

  return height;
}

function drawDonutSimple(
  doc: PDFKit.PDFDocument,
  opts: {
    x: number;
    y: number;
    size: number;
    positive: number;
    negative: number;
    title: string;
  }
) {
  const { x, y, size, positive, negative, title } = opts;
  const total = Math.max(positive + negative, 1);
  const cx = x + size / 2;
  const cy = y + size / 2 + 8;
  const r = size / 2 - 8;
  const posAngle = (positive / total) * Math.PI * 2;

  doc.roundedRect(x, y, size + 20, size + 36, 6).fillAndStroke('#ffffff', COLORS.line);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(8).text(title, x + 8, y + 6, {
    width: size + 4,
  });

  const slices = 48;
  for (let i = 0; i < slices; i++) {
    const a0 = -Math.PI / 2 + (i / slices) * Math.PI * 2;
    const a1 = -Math.PI / 2 + ((i + 1) / slices) * Math.PI * 2;
    const angFromTop = ((i + 0.5) / slices) * Math.PI * 2;
    const col = angFromTop <= posAngle ? COLORS.green : COLORS.red;
    doc
      .moveTo(cx, cy)
      .lineTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r)
      .lineTo(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r)
      .closePath()
      .fill(col);
  }
  doc.circle(cx, cy, r * 0.55).fill('#ffffff');
  const pct = Math.round((positive / total) * 100);
  doc
    .fillColor(COLORS.navy)
    .font('Helvetica-Bold')
    .fontSize(12)
    .text(`${pct}%`, cx - 18, cy - 8, { width: 36, align: 'center' });
  doc
    .fillColor(COLORS.muted)
    .font('Helvetica')
    .fontSize(7)
    .text('positivas', cx - 24, cy + 6, { width: 48, align: 'center' });
}

// ─── Layout helpers ──────────────────────────────────────────────────

function sectionTitle(doc: PDFKit.PDFDocument, title: string, subtitle: string) {
  doc.fillColor(COLORS.navy).fontSize(12).font('Helvetica-Bold').text(title);
  doc.moveDown(0.15).fillColor(COLORS.muted).fontSize(8).font('Helvetica').text(subtitle);
  doc.moveDown(0.45);
}

function drawKpi(
  doc: PDFKit.PDFDocument,
  title: string,
  value: string,
  desc: string,
  x: number,
  y: number,
  w: number
) {
  doc.roundedRect(x, y, w, 78, 6).fillAndStroke(COLORS.pale, COLORS.line);
  doc
    .fillColor(COLORS.blue)
    .fontSize(7.5)
    .font('Helvetica-Bold')
    .text(title.toUpperCase(), x + 10, y + 10, { width: w - 20 });
  doc.fillColor(COLORS.navy).fontSize(18).font('Helvetica-Bold').text(value, x + 10, y + 28, {
    width: w - 20,
  });
  doc.fillColor(COLORS.muted).fontSize(7.5).font('Helvetica').text(desc, x + 10, y + 52, {
    width: w - 20,
  });
}

// ─── Página de filial ────────────────────────────────────────────────

function paginaFilial(
  doc: PDFKit.PDFDocument,
  opts: {
    empresaNome: string;
    periodo: string;
    unidadeNome: string;
    reviews: ReviewRow[];
    elaborate: boolean;
    pageWidth: number;
  }
) {
  const { empresaNome, periodo, unidadeNome, reviews, elaborate, pageWidth } = opts;
  doc.addPage();
  const dist = distNotas(reviews);
  const m = media(reviews);
  const criticas = reviews.filter((r) => r.rating <= 3).length;
  const positivas = reviews.filter((r) => r.rating >= 4).length;

  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(14).text(`Filial: ${unidadeNome}`);
  doc
    .fillColor(COLORS.muted)
    .font('Helvetica')
    .fontSize(8)
    .text(`${empresaNome}  ·  ${periodo}  ·  Demonstrativo por unidade`);
  doc.moveDown(0.6);

  const gap = 10;
  const kw = (pageWidth - gap * 2) / 3;
  const ky = doc.y;
  drawKpi(doc, 'Avaliações', String(reviews.length), 'Volume no período', 42, ky, kw);
  drawKpi(doc, 'Nota média', m ? m.toFixed(2) : '—', 'Escala 1 a 5', 42 + kw + gap, ky, kw);
  drawKpi(doc, 'Críticas retidas', String(criticas), 'Notas 1–3 privadas', 42 + (kw + gap) * 2, ky, kw);
  doc.y = ky + 96;

  sectionTitle(doc, 'Distribuição de notas', 'Volume por estrela nesta filial');
  drawBarChart(doc, {
    x: 42,
    y: doc.y,
    width: pageWidth,
    height: 150,
    labels: ['1★', '2★', '3★', '4★', '5★'],
    values: dist,
    title: 'Quantidade de avaliações por nota',
    showValues: true,
  });
  doc.y += 166;

  if (elaborate) {
    sectionTitle(doc, 'Positivas vs críticas', 'Proporção de notas altas (4–5) e baixas (1–3)');
    drawDonutSimple(doc, {
      x: 42,
      y: doc.y,
      size: 110,
      positive: positivas,
      negative: criticas,
      title: 'Mix de sentimento',
    });
    const tx = 180;
    const ty = doc.y + 10;
    doc.roundedRect(tx, ty, pageWidth - 150, 120, 6).fillAndStroke('#ffffff', COLORS.line);
    doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(9).text('Resumo da filial', tx + 12, ty + 12);
    const lines = [
      `Positivas (4–5): ${positivas}`,
      `Críticas (1–3): ${criticas}`,
      `Taxa positiva: ${reviews.length ? Math.round((positivas / reviews.length) * 100) : 0}%`,
      `Média: ${m ? m.toFixed(2) : '—'}`,
    ];
    lines.forEach((ln, i) => {
      doc
        .fillColor(COLORS.ink)
        .font('Helvetica')
        .fontSize(9)
        .text(ln, tx + 12, ty + 34 + i * 16);
    });
    doc.y += 140;
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
  const elegivel = ['ultra', 'pro', 'corporativo', 'rei'].includes(plan);
  if (!elegivel) throw new Error('Plano não elegível para relatório mensal.');

  const isRei = plan === 'rei';
  const isCorp = plan === 'corporativo' || isRei;
  const elaborate = isRei;

  const reviews: ReviewRow[] = await db.all(
    `SELECT rating, comment, unidade_id, origin, createdAt FROM reviews
     WHERE empresa_id = ? AND strftime('%Y-%m', createdAt) = ?`,
    [empresaId, mesAno]
  );

  const unidades: UnidadeRow[] = isCorp
    ? await db.all(
        `SELECT id, nome, slug FROM unidades WHERE empresa_id = ? AND ativo = 1 ORDER BY nome`,
        [empresaId]
      )
    : [];

  const dist = distNotas(reviews);
  const notaMedia = media(reviews);
  const criticasRetidas = reviews.filter((r) => r.rating <= 3).length;
  const positivas = reviews.filter((r) => r.rating >= 4).length;
  const totalAvaliacoes = reviews.length;

  let sentimentoPrincipal = 'sem dados';
  let topGargalos: string[] = [];
  if (callGroq && reviews.some((r) => r.comment?.trim())) {
    const comentarios = reviews
      .map((r) => r.comment?.trim())
      .filter(Boolean)
      .slice(0, 80)
      .join('\n');
    const systemPrompt = `Você é um analista de experiência do cliente.
Analise o bloco de comentários e devolva JSON com:
1. "sentimento": "positivo" | "negativo" | "neutro"
2. "gargalos": lista de até 5 tópicos curtos (ex.: "tempo de espera")`;
    try {
      const raw = await callGroq(systemPrompt, comentarios);
      const parsed = JSON.parse(raw);
      sentimentoPrincipal = parsed.sentimento || 'indefinido';
      topGargalos = Array.isArray(parsed.gargalos) ? parsed.gargalos.slice(0, 5) : [];
    } catch {
      sentimentoPrincipal = 'indefinido';
    }
  }

  const [ano, mes] = mesAno.split('-');
  const nomesMeses = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
  ];
  const periodoFormatado =
    ano && Number(mes) >= 1 && Number(mes) <= 12
      ? `${nomesMeses[Number(mes) - 1]} / ${ano}`
      : mesAno;
  const emissao = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' }).format(new Date());

  const doc = new PDFDocument({
    size: 'A4',
    margin: 42,
    bufferPages: true,
    info: { Title: `${empresa.nome_empresa} — Relatório ${mesAno}` },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c) => chunks.push(c));
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const drawWatermark = () => {
    const cx = doc.page.width / 2;
    const cy = doc.page.height / 2;
    doc.save();
    doc.opacity(0.03);
    doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(54);
    doc.rotate(-45, { origin: [cx, cy] });
    doc.text('FILTRA.IA', cx - 180, cy - 30, { width: 360, align: 'center', lineBreak: false });
    doc.restore();
  };
  drawWatermark();
  doc.on('pageAdded', drawWatermark);

  doc.rect(0, 0, doc.page.width, 72).fill(COLORS.navy);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16).text('FILTRA.IA', 42, 22);
  doc
    .fillColor('#c7d2e5')
    .font('Helvetica')
    .fontSize(9)
    .text(
      isRei ? 'Relatório executivo avançado' : isCorp ? 'Relatório multi-unidades' : 'Relatório mensal',
      42,
      44
    );
  doc.y = 90;

  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(18).text(empresa.nome_empresa);
  doc
    .fillColor(COLORS.muted)
    .font('Helvetica')
    .fontSize(9)
    .text(`Período: ${periodoFormatado}  ·  Emitido em ${emissao}  ·  Plano: ${plan.toUpperCase()}`);
  doc.moveDown(0.8);

  sectionTitle(doc, 'Painel executivo', 'Indicadores consolidados do período');
  const gap = 10;
  const kw = (pageWidth - gap * 2) / 3;
  const ky = doc.y;
  drawKpi(doc, 'Volume', `${totalAvaliacoes}`, 'Avaliações no mês', 42, ky, kw);
  drawKpi(
    doc,
    'Satisfação',
    notaMedia ? `${notaMedia.toFixed(1)} / 5 (${honestNoteForRating(Math.round(notaMedia))})` : '—',
    'Nota média',
    42 + kw + gap,
    ky,
    kw
  );
  drawKpi(
    doc,
    'Escudo de marca',
    `${criticasRetidas}`,
    'Críticas retidas (1–3)',
    42 + (kw + gap) * 2,
    ky,
    kw
  );
  doc.y = ky + 96;

  sectionTitle(doc, 'Distribuição de notas', 'Volume de avaliações por estrela');
  drawBarChart(doc, {
    x: 42,
    y: doc.y,
    width: pageWidth,
    height: 160,
    labels: ['1★', '2★', '3★', '4★', '5★'],
    values: dist,
    title: 'Quantidade por nota',
  });
  doc.y += 176;

  if (elaborate) {
    if (doc.y > 520) doc.addPage();
    sectionTitle(doc, 'Análise avançada', 'Proporção positiva/crítica e principais gargalos');
    const rowY = doc.y;
    drawDonutSimple(doc, {
      x: 42,
      y: rowY,
      size: 120,
      positive: positivas,
      negative: criticasRetidas,
      title: 'Mix do período',
    });
    const items =
      topGargalos.length > 0
        ? topGargalos.map((g, i) => ({ label: g, value: topGargalos.length - i }))
        : [{ label: 'Sem gargalos recorrentes', value: 1 }];
    const hBars = drawHorizontalBars(doc, {
      x: 190,
      y: rowY,
      width: pageWidth - 148,
      title: 'Gargalos (IA)',
      items,
      color: COLORS.amber,
    });
    doc.y = rowY + Math.max(156, hBars) + 16;
  } else if (plan === 'ultra' || plan === 'pro') {
    sectionTitle(doc, 'Leitura de IA', 'Sentimento e pontos de atenção');
    const aiY = doc.y;
    doc.roundedRect(42, aiY, pageWidth, 70, 6).fillAndStroke('#ffffff', COLORS.line);
    doc
      .fillColor(COLORS.blue)
      .font('Helvetica-Bold')
      .fontSize(8)
      .text('SENTIMENTO', 56, aiY + 12);
    doc
      .fillColor(COLORS.ink)
      .font('Helvetica')
      .fontSize(10)
      .text(String(sentimentoPrincipal), 56, aiY + 28);
    doc
      .fillColor(COLORS.blue)
      .font('Helvetica-Bold')
      .fontSize(8)
      .text('GARGALOS', 56, aiY + 46);
    doc
      .fillColor(COLORS.ink)
      .font('Helvetica')
      .fontSize(9)
      .text(topGargalos.length ? topGargalos.join(', ') : 'Nenhum ponto crítico recorrente.', 120, aiY + 46, {
        width: pageWidth - 100,
      });
    doc.y = aiY + 86;
  }

  if (isCorp) {
    const grupos = agrupadoPorUnidade(reviews, unidades);
    if (doc.y > 480) doc.addPage();
    sectionTitle(
      doc,
      'Ranking de unidades',
      'Comparativo de média e volume por filial (quebra de página a seguir)'
    );

    const tableY = doc.y;
    doc.roundedRect(42, tableY, pageWidth, 22 + grupos.length * 18, 6).fillAndStroke('#ffffff', COLORS.line);
    doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(7.5);
    doc.text('UNIDADE', 54, tableY + 6, { width: 180 });
    doc.text('VOLUME', 250, tableY + 6, { width: 60 });
    doc.text('MÉDIA', 320, tableY + 6, { width: 50 });
    doc.text('CRÍTICAS', 380, tableY + 6, { width: 60 });
    doc.text('POSITIVAS', 450, tableY + 6, { width: 60 });

    grupos.forEach((g, i) => {
      const ry = tableY + 22 + i * 18;
      const m = media(g.reviews);
      const cr = g.reviews.filter((r) => r.rating <= 3).length;
      const po = g.reviews.filter((r) => r.rating >= 4).length;
      doc.fillColor(COLORS.ink).font('Helvetica').fontSize(8);
      doc.text(g.unidade.nome.slice(0, 32), 54, ry, { width: 180 });
      doc.text(String(g.reviews.length), 250, ry, { width: 60 });
      doc.text(m ? m.toFixed(2) : '—', 320, ry, { width: 50 });
      doc.text(String(cr), 380, ry, { width: 60 });
      doc.text(String(po), 450, ry, { width: 60 });
    });
    doc.y = tableY + 28 + grupos.length * 18;

    for (const g of grupos) {
      if (g.reviews.length === 0 && unidades.length === 0) continue;
      paginaFilial(doc, {
        empresaNome: empresa.nome_empresa,
        periodo: periodoFormatado,
        unidadeNome: g.unidade.nome,
        reviews: g.reviews,
        elaborate,
        pageWidth,
      });
    }
  }

  if (doc.y > 680) doc.addPage();
  sectionTitle(doc, 'Recomendação estratégica', 'Próximo passo sugerido');
  const rec =
    totalAvaliacoes === 0
      ? 'Ainda não há avaliações neste período. Divulgue o link ou o QR Code no ponto de atendimento para iniciar a coleta.'
      : criticasRetidas > positivas
        ? 'O volume de críticas retidas está elevado. Priorize os gargalos apontados e mantenha o fluxo de notas altas no Google.'
        : 'O fluxo está saudável. Mantenha o QR/link visível e use o ranking de unidades (quando houver) para alinhar filiais abaixo da média.';
  const recY = doc.y;
  doc.roundedRect(42, recY, pageWidth, 64, 6).fillAndStroke(COLORS.paleBlue, COLORS.line);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(9).text('Orientação', 56, recY + 12);
  doc.fillColor(COLORS.ink).font('Helvetica').fontSize(9).text(rec, 56, recY + 28, {
    width: pageWidth - 28,
    lineGap: 2,
  });

  await new Promise<void>((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc
        .fillColor(COLORS.muted)
        .fontSize(7)
        .font('Helvetica')
        .text(
          `© FILTRA.IA — uso exclusivo de ${empresa.nome_empresa}  ·  p. ${i - range.start + 1}/${range.count}`,
          42,
          doc.page.height - 36,
          { width: pageWidth, align: 'center' }
        );
    }
    doc.end();
  });

  return Buffer.concat(chunks);
}
