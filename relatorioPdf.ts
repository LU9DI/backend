/**
 * Relatório mensal PDF — Filtra.AI.
 *
 * Regras do produto:
 * - Inicial: sem PDF.
 * - Pro: PDF base, sem IA e sem unidades.
 * - Ultra: PDF + dados de IA.
 * - Corporativo: Ultra + visão consolidada por unidades.
 * - Rei: Corporativo + visão executiva.
 * - Trial: experiência completa do Rei.
 *
 * O relatório usa somente dados já persistidos. Não dispara IA durante o download.
 */
import type { Database } from 'sqlite';
import PDFDocument from 'pdfkit';
import { empresaTemPdf, isTrialPlan } from './lib/plans.js';

type ReviewRow = {
  rating: number;
  comment?: string | null;
  unidade_id?: string | null;
  origin?: string | null;
  createdAt?: string | Date;
  createdat?: string | Date;
  created_at?: string | Date;
  is_test?: number | boolean | null;
  ai_tags?: string | null;
  sentiment?: string | null;
};

type UnidadeRow = { id: string; nome: string; slug?: string | null };
type PdfLevel = 'pro' | 'ultra' | 'corporativo' | 'rei';

const COLORS = {
  navy: '#17233c', blue: '#4f46e5', ink: '#26364d', muted: '#65748a', line: '#d9e1eb',
  pale: '#f5f7fa', paleBlue: '#eef2ff', green: '#18794e', red: '#b42318', amber: '#b45309',
  white: '#ffffff', star: ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'],
};
const PAGE = { left: 42, right: 42, top: 94, bottom: 50 };

function normalizePlan(empresa: any): string { return String(empresa?.plan || empresa?.status || 'trial').trim().toLowerCase(); }
function levelForPlan(plan: string): PdfLevel | null {
  if (isTrialPlan(plan) || plan === 'rei') return 'rei';
  if (plan === 'corporativo' || plan === 'corporate') return 'corporativo';
  if (plan === 'ultra') return 'ultra';
  if (plan === 'pro') return 'pro';
  return null;
}
function hasAi(level: PdfLevel): boolean { return level !== 'pro'; }
function hasUnits(level: PdfLevel): boolean { return level === 'corporativo' || level === 'rei'; }
function isTest(row: ReviewRow): boolean { return Number(row.is_test) === 1 || row.is_test === true; }

function rowDate(row: ReviewRow): string | Date | null {
  return row.createdAt ?? row.createdat ?? row.created_at ?? null;
}

function isInMonth(row: ReviewRow, mesAno: string): boolean {
  const value = rowDate(row);
  if (value == null || value === '') return true;
  if (typeof value === 'string' && /^\d{4}-\d{2}/.test(value)) return value.slice(0, 7) === mesAno;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}` === mesAno;
}

function distNotas(reviews: ReviewRow[]): number[] {
  const result = [0, 0, 0, 0, 0];
  for (const review of reviews) {
    const rating = Number(review.rating);
    if (rating >= 1 && rating <= 5) result[rating - 1] += 1;
  }
  return result;
}
function media(reviews: ReviewRow[]): number {
  if (!reviews.length) return 0;
  return reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / reviews.length;
}
function percent(value: number, total: number): string { return total ? `${Math.round((value / total) * 100)}%` : '0%'; }

function parseTags(reviews: ReviewRow[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const review of reviews) {
    if (!review.ai_tags) continue;
    try {
      const parsed = JSON.parse(String(review.ai_tags));
      if (!Array.isArray(parsed)) continue;
      for (const raw of parsed) {
        const tag = String(raw || '').trim();
        if (tag) counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    } catch { /* campo inválido de IA não quebra o relatório */ }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tag, count]) => ({ tag, count }));
}

function sentimentSummary(reviews: ReviewRow[]): { positive: number; neutral: number; negative: number } {
  let positive = 0; let neutral = 0; let negative = 0;
  for (const review of reviews) {
    const value = String(review.sentiment || '').toLowerCase();
    if (value.includes('posit')) positive += 1;
    else if (value.includes('negat')) negative += 1;
    else if (value.includes('neutr')) neutral += 1;
  }
  return { positive, neutral, negative };
}

async function loadReviews(db: Database, empresaId: string, mesAno: string): Promise<ReviewRow[]> {
  let rows: any[] = [];
  try {
    rows = (await db.all('SELECT * FROM reviews WHERE empresa_id = ? ORDER BY id DESC LIMIT 2000', [empresaId])) as any[];
  } catch (error: any) {
    console.warn('[pdf] SELECT * reviews falhou:', error?.message || error);
    try {
      rows = (await db.all(
        'SELECT rating, comment, createdAt, createdat, created_at, is_test, ai_tags, sentiment, unidade_id, origin FROM reviews WHERE empresa_id = ? LIMIT 2000',
        [empresaId]
      )) as any[];
    } catch (fallbackError: any) {
      console.warn('[pdf] SELECT fallback reviews falhou:', fallbackError?.message || fallbackError);
      return [];
    }
  }
  return (rows || []).filter((row) => !isTest(row as ReviewRow)).filter((row) => isInMonth(row as ReviewRow, mesAno)) as ReviewRow[];
}

async function loadUnits(db: Database, empresaId: string): Promise<UnidadeRow[]> {
  try {
    return (await db.all('SELECT id, nome, slug FROM unidades WHERE empresa_id = ? AND ativo = 1 ORDER BY nome', [empresaId])) as UnidadeRow[];
  } catch (error: any) {
    console.warn('[pdf] unidades indisponíveis:', error?.message || error);
    return [];
  }
}

function unitGroups(reviews: ReviewRow[], units: UnidadeRow[]): { unit: UnidadeRow; reviews: ReviewRow[] }[] {
  const byId = new Map(units.map((unit) => [String(unit.id), unit]));
  const grouped = new Map<string, ReviewRow[]>();
  for (const review of reviews) {
    const key = String(review.unidade_id || review.origin || '_geral');
    const list = grouped.get(key) || [];
    list.push(review);
    grouped.set(key, list);
  }
  const result: { unit: UnidadeRow; reviews: ReviewRow[] }[] = [];
  for (const [key, list] of grouped) result.push({ unit: byId.get(key) || { id: key, nome: key === '_geral' ? 'Matriz / Geral' : key }, reviews: list });
  for (const unit of units) if (!grouped.has(String(unit.id))) result.push({ unit, reviews: [] });
  return result.sort((a, b) => media(b.reviews) - media(a.reviews));
}

function addPageHeader(doc: PDFKit.PDFDocument, planLabel: string, periodo: string): void {
  doc.rect(0, 0, doc.page.width, 76).fill(COLORS.navy);
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(18).text('Filtra.AI', PAGE.left, 19);
  doc.fillColor('#c7d2e5').font('Helvetica').fontSize(8.5).text('Relatório de reputação · dados do painel', PAGE.left, 45);
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(8).text(planLabel, doc.page.width - 132, 20, { width: 90, align: 'right' });
  doc.fillColor('#c7d2e5').font('Helvetica').fontSize(7.5).text(periodo, doc.page.width - 132, 39, { width: 90, align: 'right' });
  doc.y = PAGE.top;
}
function footer(doc: PDFKit.PDFDocument, empresaNome: string, pageNumber: number, totalPages: number): void {
  const width = doc.page.width - PAGE.left - PAGE.right;
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7).text(`© Filtra.AI · ${empresaNome} · página ${pageNumber}/${totalPages}`, PAGE.left, doc.page.height - PAGE.bottom + 4, { width, align: 'center', lineBreak: false });
}
function sectionTitle(doc: PDFKit.PDFDocument, title: string, subtitle?: string): void {
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(13).text(title, PAGE.left, doc.y, { width: doc.page.width - PAGE.left - PAGE.right });
  if (subtitle) { doc.moveDown(0.2); doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8).text(subtitle, { width: doc.page.width - PAGE.left - PAGE.right }); }
  doc.moveDown(0.45);
}
function ensureSpace(doc: PDFKit.PDFDocument, required: number, planLabel: string, periodo: string): void {
  if (doc.y + required <= doc.page.height - PAGE.bottom - 14) return;
  doc.addPage();
  addPageHeader(doc, planLabel, periodo);
}
function kpi(doc: PDFKit.PDFDocument, x: number, y: number, width: number, title: string, value: string, desc: string, accent: string): void {
  doc.roundedRect(x, y, width, 76, 7).fillAndStroke(COLORS.pale, COLORS.line);
  doc.roundedRect(x, y, 4, 76, 2).fill(accent);
  doc.fillColor(COLORS.blue).font('Helvetica-Bold').fontSize(7.5).text(title.toUpperCase(), x + 12, y + 10, { width: width - 20 });
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(18).text(value, x + 12, y + 28, { width: width - 20 });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5).text(desc, x + 12, y + 52, { width: width - 20 });
}
function drawBars(doc: PDFKit.PDFDocument, reviews: ReviewRow[]): void {
  const width = doc.page.width - PAGE.left - PAGE.right; const y = doc.y; const height = 150;
  const dist = distNotas(reviews); const max = Math.max(...dist, 1); const gap = 12;
  const barWidth = (width - gap * 6) / 5; const top = y + 30; const chartHeight = height - 54;
  doc.roundedRect(PAGE.left, y, width, height, 7).fillAndStroke(COLORS.white, COLORS.line);
  for (let i = 0; i < 5; i += 1) {
    const value = dist[i]; const barHeight = (value / max) * chartHeight; const x = PAGE.left + gap + i * (barWidth + gap); const barY = top + chartHeight - barHeight;
    doc.roundedRect(x, barY, barWidth, Math.max(barHeight, 1), 4).fill(COLORS.star[i]);
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8).text(String(value), x, barY - 12, { width: barWidth, align: 'center' });
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5).text(`${i + 1}★`, x, top + chartHeight + 7, { width: barWidth, align: 'center' });
  }
  doc.y = y + height + 14;
}
function drawUnitTable(doc: PDFKit.PDFDocument, groups: { unit: UnidadeRow; reviews: ReviewRow[] }[]): void {
  const width = doc.page.width - PAGE.left - PAGE.right; const rowHeight = 20; const headerHeight = 24; const height = headerHeight + Math.max(groups.length, 1) * rowHeight; const y = doc.y;
  doc.roundedRect(PAGE.left, y, width, height, 7).fillAndStroke(COLORS.white, COLORS.line);
  doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(7.5);
  doc.text('UNIDADE', PAGE.left + 12, y + 7, { width: 180 }); doc.text('VOLUME', PAGE.left + 205, y + 7, { width: 55 }); doc.text('MÉDIA', PAGE.left + 270, y + 7, { width: 50 }); doc.text('CRÍTICAS', PAGE.left + 335, y + 7, { width: 55 }); doc.text('POSITIVAS', PAGE.left + 405, y + 7, { width: 60 });
  if (!groups.length) doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8).text('Nenhuma unidade ativa cadastrada.', PAGE.left + 12, y + 34, { width: width - 24 });
  else groups.forEach((group, index) => {
    const rowY = y + headerHeight + index * rowHeight; const avg = media(group.reviews); const critical = group.reviews.filter((r) => Number(r.rating) <= 3).length; const positive = group.reviews.filter((r) => Number(r.rating) >= 4).length;
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(8); doc.text(String(group.unit.nome || 'Unidade').slice(0, 30), PAGE.left + 12, rowY + 5, { width: 180 }); doc.text(String(group.reviews.length), PAGE.left + 205, rowY + 5, { width: 55 }); doc.text(avg ? avg.toFixed(2) : '—', PAGE.left + 270, rowY + 5, { width: 50 }); doc.text(String(critical), PAGE.left + 335, rowY + 5, { width: 55 }); doc.text(String(positive), PAGE.left + 405, rowY + 5, { width: 60 });
  });
  doc.y = y + height + 14;
}
function drawUnitPage(doc: PDFKit.PDFDocument, empresaNome: string, periodo: string, unit: UnidadeRow, reviews: ReviewRow[], planLabel: string): void {
  doc.addPage(); addPageHeader(doc, planLabel, periodo);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(16).text(String(unit.nome || 'Unidade')); doc.moveDown(0.2);
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8).text(`${empresaNome} · visão operacional da unidade`); doc.moveDown(0.8);
  const width = doc.page.width - PAGE.left - PAGE.right; const gap = 10; const kw = (width - gap * 2) / 3; const y = doc.y; const critical = reviews.filter((r) => Number(r.rating) <= 3).length;
  kpi(doc, PAGE.left, y, kw, 'Avaliações', String(reviews.length), 'No período', COLORS.blue); kpi(doc, PAGE.left + kw + gap, y, kw, 'Nota média', media(reviews) ? media(reviews).toFixed(2) : '—', 'Escala 1 a 5', COLORS.blue); kpi(doc, PAGE.left + (kw + gap) * 2, y, kw, 'Críticas', String(critical), 'Notas 1–3', COLORS.red); doc.y = y + 94;
  sectionTitle(doc, 'Distribuição de notas', 'Volume de avaliações por estrela'); drawBars(doc, reviews);
  sectionTitle(doc, 'Resumo da unidade'); const positive = reviews.filter((r) => Number(r.rating) >= 4).length;
  doc.fillColor(COLORS.ink).font('Helvetica').fontSize(9).text(`Positivas: ${positive} (${percent(positive, reviews.length)}) · Críticas: ${critical} (${percent(critical, reviews.length)}) · Média: ${media(reviews) ? media(reviews).toFixed(2) : '—'}`, { width });
}

export async function ensureUnidadesSchema(db: Database): Promise<void> {
  try { await db.exec('CREATE TABLE IF NOT EXISTS unidades (id TEXT PRIMARY KEY, empresa_id TEXT NOT NULL, nome TEXT NOT NULL, slug TEXT, ativo INTEGER DEFAULT 1, criado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)'); }
  catch (error: any) { console.warn('[pdf] ensure unidades:', error?.message || error); }
  for (const ddl of ['unidade_id TEXT', 'origin TEXT']) {
    try { await db.exec(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS ${ddl}`); }
    catch { try { await db.exec(`ALTER TABLE reviews ADD COLUMN ${ddl}`); } catch { /* já existe */ } }
  }
}

export async function gerarRelatorioMensalPDF(db: Database, empresaId: string, mesAno: string, _callGroq?: (system: string, user: string) => Promise<string>): Promise<Buffer> {
  await ensureUnidadesSchema(db);
  const empresa = await db.get('SELECT * FROM empresas WHERE id = ?', [empresaId]);
  if (!empresa) throw new Error('Empresa não encontrada.');

  const plan = normalizePlan(empresa); const level = levelForPlan(plan);
  if (!level || !empresaTemPdf(empresa)) throw new Error('Plano não elegível para relatório mensal.');
  const trial = isTrialPlan(plan); const aiEnabled = hasAi(level); const unitsEnabled = hasUnits(level);
  const planLabel = trial ? 'TRIAL · COMPLETO' : plan === 'corporativo' || plan === 'corporate' ? 'CORPORATIVO' : plan.toUpperCase();

  const reviews = await loadReviews(db, empresaId, mesAno); const units = unitsEnabled ? await loadUnits(db, empresaId) : []; const groups = unitsEnabled ? unitGroups(reviews, units) : [];
  const total = reviews.length; const average = media(reviews); const critical = reviews.filter((r) => Number(r.rating) <= 3).length; const positive = reviews.filter((r) => Number(r.rating) >= 4).length;
  const tags = aiEnabled ? parseTags(reviews) : []; const sentiment = aiEnabled ? sentimentSummary(reviews) : { positive: 0, neutral: 0, negative: 0 };

  const [year, month] = String(mesAno).split('-'); const months = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const periodo = year && Number(month) >= 1 && Number(month) <= 12 ? `${months[Number(month) - 1]} / ${year}` : mesAno;
  const emissao = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' }).format(new Date()); const empresaNome = String(empresa.nome_empresa || 'Empresa');

  const doc = new PDFDocument({ size: 'A4', margin: PAGE.left, bufferPages: true, info: { Title: `${empresaNome} — Relatório Filtra.AI — ${mesAno}`, Author: 'Filtra.AI', Subject: `Relatório de reputação — ${periodo}`, Creator: 'Filtra.AI' } });
  const chunks: Buffer[] = []; doc.on('data', (chunk: Buffer) => chunks.push(chunk)); addPageHeader(doc, planLabel, periodo);

  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(18).text(empresaNome); doc.moveDown(0.15); doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8.5).text(`Período analisado: ${periodo} · Emitido em ${emissao}`); doc.moveDown(0.8);
  sectionTitle(doc, 'Resumo do período', 'Indicadores consolidados das avaliações válidas');
  const contentWidth = doc.page.width - PAGE.left - PAGE.right; const gap = 10; const kw = (contentWidth - gap * 2) / 3; const kpiY = doc.y;
  kpi(doc, PAGE.left, kpiY, kw, 'Volume', String(total), 'Avaliações válidas', COLORS.blue); kpi(doc, PAGE.left + kw + gap, kpiY, kw, 'Nota média', average ? average.toFixed(2) : '—', 'Escala 1 a 5', COLORS.blue); kpi(doc, PAGE.left + (kw + gap) * 2, kpiY, kw, 'Críticas', String(critical), 'Notas 1–3', COLORS.red); doc.y = kpiY + 94;

  sectionTitle(doc, 'Distribuição de notas', 'Volume de avaliações por estrela'); drawBars(doc, reviews);
  ensureSpace(doc, 90, planLabel, periodo); sectionTitle(doc, 'Positivas vs críticas', 'Comparação do volume de notas altas e baixas');
  doc.fillColor(COLORS.ink).font('Helvetica').fontSize(9.5).text(`Positivas (4–5★): ${positive} (${percent(positive, total)})   ·   Críticas (1–3★): ${critical} (${percent(critical, total)})`, { width: contentWidth }); doc.moveDown(0.8);

  if (total === 0) {
    doc.roundedRect(PAGE.left, doc.y, contentWidth, 58, 7).fillAndStroke(COLORS.pale, COLORS.line); doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9).text('Nenhuma avaliação válida foi registrada neste período. O relatório permanece disponível e será preenchido conforme novos feedbacks forem coletados.', PAGE.left + 12, doc.y + 12, { width: contentWidth - 24 }); doc.y += 72;
  }

  if (aiEnabled) {
    ensureSpace(doc, 150, planLabel, periodo); sectionTitle(doc, 'Análise com IA', 'Somente dados de IA já registrados no sistema');
    const aiY = doc.y; const cardGap = 10; const cardWidth = (contentWidth - cardGap * 2) / 3;
    kpi(doc, PAGE.left, aiY, cardWidth, 'Positivas', String(sentiment.positive), 'Sentimento registrado', COLORS.green); kpi(doc, PAGE.left + cardWidth + cardGap, aiY, cardWidth, 'Neutras', String(sentiment.neutral), 'Sentimento registrado', COLORS.blue); kpi(doc, PAGE.left + (cardWidth + cardGap) * 2, aiY, cardWidth, 'Negativas', String(sentiment.negative), 'Sentimento registrado', COLORS.red); doc.y = aiY + 94;
    if (tags.length) {
      sectionTitle(doc, 'Principais temas', 'Temas encontrados nas análises já processadas');
      for (const item of tags) { ensureSpace(doc, 20, planLabel, periodo); doc.fillColor(COLORS.ink).font('Helvetica').fontSize(9).text(`• ${item.tag} — ${item.count} ocorrência${item.count === 1 ? '' : 's'}`, { width: contentWidth }); doc.moveDown(0.2); }
    } else {
      doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8.5).text('Ainda não há temas de IA persistidos para este período. Nenhuma chamada de IA foi feita durante a geração do PDF.', { width: contentWidth }); doc.moveDown(0.8);
    }
  }

  if (unitsEnabled) {
    ensureSpace(doc, 120, planLabel, periodo); sectionTitle(doc, 'Visão consolidada por unidades', 'Comparativo das unidades ativas no período'); drawUnitTable(doc, groups);
    for (const group of groups) drawUnitPage(doc, empresaNome, periodo, group.unit, group.reviews, planLabel);
  }

  ensureSpace(doc, 100, planLabel, periodo); sectionTitle(doc, 'Recomendação', 'Próximo passo baseado nos números do período');
  const recommendation = total === 0 ? 'Comece a coleta de avaliações para formar uma linha de base de reputação.' : critical > positive ? 'As críticas superam as avaliações positivas. Priorize os principais pontos de atrito antes de ampliar a divulgação.' : 'A reputação está saudável no período. Continue estimulando avaliações e acompanhe mudanças na média e no volume.';
  doc.roundedRect(PAGE.left, doc.y, contentWidth, 70, 7).fillAndStroke(COLORS.paleBlue, COLORS.line); doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(9).text('Orientação', PAGE.left + 12, doc.y + 12); doc.fillColor(COLORS.ink).font('Helvetica').fontSize(9).text(recommendation, PAGE.left + 12, doc.y + 29, { width: contentWidth - 24, lineGap: 2 });

  await new Promise<void>((resolve, reject) => {
    doc.on('error', reject); doc.on('end', resolve);
    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) { doc.switchToPage(index); footer(doc, empresaNome, index - range.start + 1, range.count); }
    doc.end();
  });
  const buffer = Buffer.concat(chunks); if (!buffer.length) throw new Error('PDF gerado vazio.'); return buffer;
}
