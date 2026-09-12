/**
 * Relatorio mensal PDF v3.
 *
 * Relatorios orientados a decisao, com niveis por plano:
 * - Pro: visao executiva + distribuicao + criticas.
 * - Ultra: Pro + sentimento + tendencia + temas + resposta IA.
 * - Corporativo: Ultra + comparativo por unidade.
 * - Rei/Trial: Corporativo + central de acao + apendice operacional.
 *
 * O PDF usa somente dados ja registrados no painel. Nao chama IA e nao faz previsoes.
 */
import type { Database } from 'sqlite';
import PDFDocument from 'pdfkit';
import { planTemPdf } from './lib/plans.js';

type Review = Record<string, any>;
type Unit = { id: string; nome: string; ativo?: any };
type ReportLevel = 'pro' | 'ultra' | 'corporativo' | 'rei';

const C = {
  navy: '#17233c', blue: '#4f46e5', ink: '#26364d', muted: '#65748a', line: '#d9e1eb',
  pale: '#f5f7fa', paleBlue: '#eef2ff', green: '#16804b', red: '#b42318', amber: '#b7791f', white: '#ffffff'
};
const PAGE = { left: 42, right: 42, bottom: 44, top: 96 };
const FOOTER_Y = 804;

export async function ensureUnidadesSchema(db: Database): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS unidades (
    id TEXT PRIMARY KEY, empresa_id TEXT NOT NULL, nome TEXT NOT NULL, slug TEXT,
    ativo INTEGER DEFAULT 1, criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id)
  )`);
  const cols = (await db.all(`PRAGMA table_info(reviews)`)).map((c: any) => c.name);
  if (!cols.includes('unidade_id')) await db.exec(`ALTER TABLE reviews ADD COLUMN unidade_id TEXT`);
  if (!cols.includes('origin')) await db.exec(`ALTER TABLE reviews ADD COLUMN origin TEXT`);
}

function levelForPlan(plan: string): ReportLevel {
  const p = String(plan || '').toLowerCase();
  if (p === 'trial' || p === 'teste' || p === 'rei') return 'rei';
  if (p === 'corporativo') return 'corporativo';
  if (p === 'ultra') return 'ultra';
  return 'pro';
}
function monthKey(value: any): string {
  const s = String(value || '');
  if (/^\d{4}-\d{2}/.test(s)) return s.slice(0, 7);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 7);
}
function isTest(r: Review): boolean { return Number(r.is_test || 0) === 1 || r.is_test === true; }
function avg(rows: Review[]): number { return rows.length ? rows.reduce((s, r) => s + Number(r.rating || 0), 0) / rows.length : 0; }
function pct(n: number, total: number): string { return total ? `${Math.round((n / total) * 100)}%` : '0%'; }
function dist(rows: Review[]): number[] {
  const out = [0, 0, 0, 0, 0];
  for (const r of rows) { const n = Number(r.rating); if (n >= 1 && n <= 5) out[n - 1] += 1; }
  return out;
}
function positives(rows: Review[]): Review[] { return rows.filter((r) => Number(r.rating) >= 4); }
function critical(rows: Review[]): Review[] { return rows.filter((r) => Number(r.rating) <= 3); }
function sentimentCounts(rows: Review[]) {
  const c = { positive: 0, neutral: 0, negative: 0, unknown: 0 };
  for (const r of rows) {
    const s = String(r.sentiment || '').toLowerCase();
    if (s.includes('positive') || s.includes('positiv')) c.positive += 1;
    else if (s.includes('negative') || s.includes('negativ') || s.includes('critical') || s.includes('crit')) c.negative += 1;
    else if (s.includes('neutral')) c.neutral += 1; else c.unknown += 1;
  }
  return c;
}
function tagCounts(rows: Review[]) {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    if (!r.ai_tags) continue;
    try { const tags = JSON.parse(String(r.ai_tags)); if (Array.isArray(tags)) for (const tag of tags) {
      const k = String(tag).trim(); if (k) counts[k] = (counts[k] || 0) + 1;
    }} catch {}
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
}
function fraudCount(rows: Review[]): number {
  return rows.filter((r) => { const s = String(r.fraud_flags || '').trim(); return Boolean(s && s !== '[]' && s !== '{}'); }).length;
}
function responseCount(rows: Review[]): number { return critical(rows).filter((r) => String(r.ai_reply || '').trim()).length; }
function monthLabel(mesAno: string): string {
  const [ano, mes] = mesAno.split('-');
  const nomes = ['Janeiro','Fevereiro','Marco','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const i = Number(mes) - 1; return ano && i >= 0 && i < 12 ? `${nomes[i]} / ${ano}` : mesAno;
}
function reportSubtitle(level: ReportLevel): string {
  if (level === 'rei') return 'Relatorio executivo - dados do painel';
  if (level === 'corporativo') return 'Relatorio multi-unidades - dados do painel';
  if (level === 'ultra') return 'Relatorio analitico - dados do painel';
  return 'Relatorio mensal - dados do painel';
}
function drawWatermark(doc: PDFKit.PDFDocument) {
  const cx = doc.page.width / 2, cy = doc.page.height / 2;
  doc.save(); doc.opacity(0.055); doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(50);
  doc.rotate(-45, { origin: [cx, cy] }); doc.text('FILTRA.AI', cx - 165, cy - 24, { width: 330, align: 'center', lineBreak: false, height: 60 }); doc.restore();
}
function drawHeader(doc: PDFKit.PDFDocument, empresa: string, periodo: string, plan: string, level: ReportLevel) {
  doc.rect(0, 0, doc.page.width, 76).fill(C.navy);
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(18).text('FILTRA.AI', PAGE.left, 18, { lineBreak: false });
  doc.fillColor('#c7d2e5').font('Helvetica').fontSize(8.5).text(reportSubtitle(level), PAGE.left, 45, { lineBreak: false });
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(8).text(plan.toUpperCase(), doc.page.width - 140, 21, { width: 98, align: 'right', lineBreak: false });
  doc.fillColor('#c7d2e5').font('Helvetica').fontSize(7.5).text(periodo, doc.page.width - 140, 38, { width: 98, align: 'right', lineBreak: false });
  doc.y = PAGE.top; doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(18).text(empresa, PAGE.left, doc.y, { lineBreak: false });
  doc.moveDown(0.2).fillColor(C.muted).font('Helvetica').fontSize(8).text(`Periodo analisado: ${periodo}`, { lineBreak: false }); doc.moveDown(0.8);
}
function drawFooter(doc: PDFKit.PDFDocument, empresa: string, page: number, total: number) {
  const y = FOOTER_Y; doc.save(); doc.strokeColor(C.line).lineWidth(0.5).moveTo(PAGE.left, y - 8).lineTo(doc.page.width - PAGE.right, y - 8).stroke();
  doc.fillColor(C.muted).font('Helvetica').fontSize(7).text(`FILTRA.AI - uso exclusivo de ${empresa}`, PAGE.left, y, { width: 300, lineBreak: false, height: 10 });
  doc.text(`Pagina ${page}/${total}`, doc.page.width - PAGE.right - 86, y, { width: 86, align: 'right', lineBreak: false, height: 10 }); doc.restore();
}
function section(doc: PDFKit.PDFDocument, title: string, subtitle?: string) {
  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(13).text(title, { lineBreak: false });
  if (subtitle) doc.moveDown(0.16).fillColor(C.muted).font('Helvetica').fontSize(8.5).text(subtitle, { lineBreak: false }); doc.moveDown(0.45);
}
function kpi(doc: PDFKit.PDFDocument, title: string, value: string, desc: string, x: number, y: number, width: number, accent = C.blue) {
  doc.roundedRect(x, y, width, 74, 7).fillAndStroke(C.pale, C.line); doc.roundedRect(x, y, 4, 74, 2).fill(accent);
  doc.fillColor(C.blue).font('Helvetica-Bold').fontSize(7.2).text(title.toUpperCase(), x + 12, y + 10, { width: width - 20, lineBreak: false });
  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(18).text(value, x + 12, y + 28, { width: width - 20, lineBreak: false });
  doc.fillColor(C.muted).font('Helvetica').fontSize(7.2).text(desc, x + 12, y + 52, { width: width - 20, lineBreak: false });
}
function ensureSpace(doc: PDFKit.PDFDocument, needed: number, empresa: string, periodo: string, plan: string, level: ReportLevel) {
  if (doc.y + needed <= doc.page.height - PAGE.bottom) return; doc.addPage(); drawHeader(doc, empresa, periodo, plan, level);
}
function drawScoreBand(doc: PDFKit.PDFDocument, rows: Review[], x: number, y: number, width: number) {
  const d = dist(rows), max = Math.max(...d, 1), barW = (width - 40) / 5;
  doc.roundedRect(x, y, width, 152, 7).fillAndStroke(C.white, C.line); doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(9).text('Distribuicao de notas', x + 12, y + 11, { lineBreak: false });
  for (let i = 0; i < 5; i++) {
    const h = 78 * (d[i] / max), bx = x + 14 + i * barW, by = y + 118 - h;
    doc.roundedRect(bx, by, barW - 12, Math.max(2, h), 4).fill(i < 2 ? C.red : i === 2 ? C.amber : C.green);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(8).text(String(d[i]), bx, by - 13, { width: barW - 12, align: 'center', lineBreak: false });
    doc.fillColor(C.muted).font('Helvetica').fontSize(7.2).text(`${i + 1}/5`, bx, y + 122, { width: barW - 12, align: 'center', lineBreak: false });
  }
}
function drawSentiment(doc: PDFKit.PDFDocument, rows: Review[], x: number, y: number, width: number) {
  const s = sentimentCounts(rows), known = s.positive + s.neutral + s.negative;
  doc.roundedRect(x, y, width, 112, 7).fillAndStroke(C.white, C.line); doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(9).text('Sentimento registrado', x + 12, y + 11, { lineBreak: false });
  ([['Positivo', s.positive, C.green], ['Neutro', s.neutral, C.amber], ['Negativo', s.negative, C.red]] as const).forEach(([label, n, color], i) => {
    const yy = y + 34 + i * 21; doc.roundedRect(x + 12, yy + 2, 8, 8, 2).fill(color); doc.fillColor(C.ink).font('Helvetica').fontSize(8).text(label, x + 26, yy, { width: 90, lineBreak: false }); doc.fillColor(C.muted).text(`${n} (${pct(n, Math.max(known, 1))})`, x + 118, yy, { width: width - 130, lineBreak: false });
  });
}
function drawTags(doc: PDFKit.PDFDocument, tags: [string, number][], x: number, y: number, width: number) {
  const rows = Math.max(tags.length, 1), height = 34 + rows * 21;
  doc.roundedRect(x, y, width, height, 7).fillAndStroke(C.white, C.line); doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(9).text('Temas registrados pela IA', x + 12, y + 10, { lineBreak: false });
  if (!tags.length) { doc.fillColor(C.muted).font('Helvetica').fontSize(8).text('Nenhum tema registrado no periodo.', x + 12, y + 30, { lineBreak: false }); return height; }
  const max = Math.max(...tags.map(([, n]) => n), 1);
  tags.forEach(([tag, n], i) => { const ry = y + 29 + i * 21; doc.fillColor(C.ink).font('Helvetica').fontSize(8).text(tag.slice(0, 28), x + 12, ry, { width: 120, lineBreak: false }); doc.roundedRect(x + 138, ry + 1, Math.max(3, (n / max) * (width - 180)), 9, 3).fill(C.blue); doc.fillColor(C.muted).fontSize(7.5).text(String(n), x + width - 30, ry, { width: 18, align: 'right', lineBreak: false }); });
  return height;
}
function drawCriticalTable(doc: PDFKit.PDFDocument, rows: Review[], x: number, y: number, width: number, limit: number) {
  const selected = critical(rows).sort((a, b) => Number(a.rating) - Number(b.rating) || String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
  const rowH = 48, headerH = 24, height = headerH + Math.max(selected.length, 1) * rowH;
  doc.roundedRect(x, y, width, height, 7).fillAndStroke(C.white, C.line); doc.rect(x, y, width, headerH).fill(C.pale); doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(7.2);
  doc.text('AVALIACAO', x + 10, y + 8, { width: 60, lineBreak: false }); doc.text('CLIENTE / DATA', x + 76, y + 8, { width: 92, lineBreak: false }); doc.text('COMENTARIO', x + 176, y + 8, { width: 250, lineBreak: false }); doc.text('RESPOSTA', x + width - 70, y + 8, { width: 55, align: 'right', lineBreak: false });
  selected.forEach((r, i) => {
    const ry = y + headerH + i * rowH, rating = `${Number(r.rating)}/5`, cliente = String(r.name || 'Anonimo').slice(0, 18), data = String(r.createdAt || '').slice(0, 10), comment = String(r.comment || 'Sem comentario').replace(/\s+/g, ' ').slice(0, 92);
    doc.fillColor(Number(r.rating) <= 2 ? C.red : C.amber).font('Helvetica-Bold').fontSize(8).text(rating, x + 10, ry + 9, { width: 60, lineBreak: false });
    doc.fillColor(C.ink).font('Helvetica').fontSize(7.5).text(cliente, x + 76, ry + 6, { width: 92, lineBreak: false, height: 10 });
    doc.fillColor(C.muted).fontSize(7).text(data, x + 76, ry + 18, { width: 92, lineBreak: false, height: 10 });
    doc.fillColor(C.ink).fontSize(7.5).text(comment, x + 176, ry + 7, { width: 250, lineBreak: false, height: 30 });
    doc.fillColor(String(r.ai_reply || '').trim() ? C.green : C.red).font('Helvetica-Bold').fontSize(7).text(String(r.ai_reply || '').trim() ? 'SIM' : 'NAO', x + width - 70, ry + 9, { width: 55, align: 'right', lineBreak: false });
  });
  return height;
}
function drawUnits(doc: PDFKit.PDFDocument, rows: Review[], units: Unit[], x: number, y: number, width: number) {
  const active = units.filter((u) => Number(u.ativo ?? 1) !== 0); if (!active.length) return 0;
  const groups = active.map((u) => { const rs = rows.filter((r) => String(r.unidade_id || '') === u.id); return { u, n: rs.length, m: avg(rs), c: critical(rs).length, p: positives(rs).length }; });
  const rowH = 23, headerH = 25, height = headerH + groups.length * rowH;
  doc.roundedRect(x, y, width, height, 7).fillAndStroke(C.white, C.line); doc.rect(x, y, width, headerH).fill(C.pale); doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(7.2);
  doc.text('UNIDADE', x + 10, y + 8, { width: 205, lineBreak: false }); doc.text('VOLUME', x + 220, y + 8, { width: 55, lineBreak: false }); doc.text('MEDIA', x + 285, y + 8, { width: 55, lineBreak: false }); doc.text('CRITICAS', x + 350, y + 8, { width: 60, lineBreak: false }); doc.text('POSITIVAS', x + 420, y + 8, { width: 70, lineBreak: false });
  groups.forEach((g, i) => { const ry = y + headerH + i * rowH; doc.fillColor(C.ink).font('Helvetica').fontSize(8).text(g.u.nome.slice(0, 34), x + 10, ry + 7, { width: 205, lineBreak: false }); doc.text(String(g.n), x + 220, ry + 7, { width: 55, lineBreak: false }); doc.text(g.m ? g.m.toFixed(2) : '-', x + 285, ry + 7, { width: 55, lineBreak: false }); doc.text(String(g.c), x + 350, ry + 7, { width: 60, lineBreak: false }); doc.text(String(g.p), x + 420, ry + 7, { width: 70, lineBreak: false }); });
  return height;
}
function drawActionBox(doc: PDFKit.PDFDocument, rows: Review[], x: number, y: number, width: number) {
  const total = rows.length, crit = critical(rows).length, recent = critical(rows).filter((r) => { const t = new Date(String(r.createdAt || '')).getTime(); return Number.isFinite(t) && Date.now() - t <= 24 * 60 * 60 * 1000; }).length, response = responseCount(rows), fraud = fraudCount(rows);
  const actions: string[] = [];
  if (crit > 0) actions.push(`Priorizar ${crit} avaliacao(oes) critica(s) no acompanhamento da equipe.`);
  if (recent > 0) actions.push(`Revisar ${recent} critica(s) registrada(s) nas ultimas 24 horas.`);
  if (crit > 0 && response < crit) actions.push(`Acompanhar as criticas ainda sem resposta registrada (${crit - response}).`);
  if (fraud > 0) actions.push(`Verificar ${fraud} avaliacao(oes) com sinalizacao anti-fraude.`);
  if (!actions.length) actions.push(total ? 'Nenhum alerta operacional relevante foi encontrado no periodo.' : 'Sem dados suficientes para gerar alertas no periodo.');
  const height = 54 + actions.length * 20;
  doc.roundedRect(x, y, width, height, 7).fillAndStroke(C.paleBlue, C.line); doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(10).text('Central de acao', x + 12, y + 10, { lineBreak: false });
  actions.forEach((a, i) => { const yy = y + 31 + i * 20; doc.circle(x + 16, yy + 4, 2.5).fill(i === 0 ? C.blue : C.muted); doc.fillColor(C.ink).font('Helvetica').fontSize(8).text(a, x + 26, yy, { width: width - 38, lineBreak: false, height: 14 }); });
  return height;
}

export async function gerarRelatorioMensalPDF(db: Database, empresaId: string, mesAno: string, _callGroq?: (system: string, user: string) => Promise<string>): Promise<Buffer> {
  await ensureUnidadesSchema(db);
  const empresa = await db.get('SELECT * FROM empresas WHERE id = ?', [empresaId]);
  if (!empresa) throw new Error('Empresa nao encontrada.');
  const plan = String(empresa.plan || '').toLowerCase();
  if (!planTemPdf(plan)) throw new Error('Plano nao elegivel para relatorio mensal.');
  const level = levelForPlan(plan);
  const allReviews: Review[] = await db.all(`SELECT * FROM reviews WHERE empresa_id = ? ORDER BY createdAt DESC LIMIT 5000`, [empresaId]);
  const rows = allReviews.filter((r) => !isTest(r) && monthKey(r.createdAt) === mesAno);
  const units: Unit[] = level === 'corporativo' || level === 'rei' ? await db.all(`SELECT id, nome, ativo FROM unidades WHERE empresa_id = ? ORDER BY nome`, [empresaId]) : [];
  const total = rows.length, crit = critical(rows).length, pos = positives(rows).length, response = responseCount(rows), fraud = fraudCount(rows), sent = sentimentCounts(rows), tags = tagCounts(rows);
  const periodo = monthLabel(mesAno), emissao = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' }).format(new Date());
  const doc = new PDFDocument({ size: 'A4', margin: PAGE.left, bufferPages: true, info: { Title: `${empresa.nome_empresa} - Relatorio ${mesAno}` } });
  const chunks: Buffer[] = []; doc.on('data', (c) => chunks.push(c)); drawWatermark(doc); doc.on('pageAdded', () => drawWatermark(doc));
  drawHeader(doc, empresa.nome_empresa, periodo, plan === 'trial' || plan === 'teste' ? 'trial' : plan, level);
  const width = doc.page.width - PAGE.left - PAGE.right, gap = 10, kw = (width - gap * 2) / 3;

  section(doc, 'Resumo executivo', 'Leitura direta do periodo selecionado');
  const y = doc.y; kpi(doc, 'Avaliacoes', String(total), 'Volume valido', PAGE.left, y, kw); kpi(doc, 'Nota media', avg(rows) ? avg(rows).toFixed(2) : '-', 'Escala de 1 a 5', PAGE.left + kw + gap, y, kw); kpi(doc, 'Criticas', String(crit), 'Notas de 1 a 3', PAGE.left + (kw + gap) * 2, y, kw, C.red); doc.y = y + 92;
  ensureSpace(doc, 180, empresa.nome_empresa, periodo, plan, level); drawScoreBand(doc, rows, PAGE.left, doc.y, width); doc.y += 172;
  ensureSpace(doc, 145, empresa.nome_empresa, periodo, plan, level); kpi(doc, 'Positivas', String(pos), `${pct(pos, total)} do volume`, PAGE.left, doc.y, kw, C.green); kpi(doc, 'Resposta registrada', String(response), crit ? `${pct(response, crit)} das criticas` : 'Sem criticas no periodo', PAGE.left + kw + gap, doc.y, kw, C.blue); kpi(doc, 'Alertas anti-fraude', String(fraud), 'Avaliacoes sinalizadas', PAGE.left + (kw + gap) * 2, doc.y, kw, fraud ? C.amber : C.blue); doc.y += 94;

  ensureSpace(doc, 210, empresa.nome_empresa, periodo, plan, level); section(doc, 'Avaliacoes criticas', 'Amostra operacional para acompanhamento da equipe'); const criticalLimit = level === 'rei' ? 8 : 5; const tableH = drawCriticalTable(doc, rows, PAGE.left, doc.y, width, criticalLimit); doc.y += tableH + 18;

  if (level === 'ultra' || level === 'corporativo' || level === 'rei') {
    ensureSpace(doc, 130, empresa.nome_empresa, periodo, plan, level); section(doc, 'Sentimento e temas', 'Indicadores ja registrados no sistema'); drawSentiment(doc, rows, PAGE.left, doc.y, (width - gap) / 2); const tagsH = 34 + Math.max(tags.length, 1) * 21; drawTags(doc, tags, PAGE.left + (width + gap) / 2, doc.y, (width - gap) / 2); doc.y += Math.max(112, tagsH) + 18;
  }
  if (level === 'corporativo' || level === 'rei') {
    ensureSpace(doc, 120, empresa.nome_empresa, periodo, plan, level); section(doc, 'Visao por unidade', level === 'rei' ? 'Comparativo executivo das unidades ativas' : 'Comparativo das unidades ativas'); const h = drawUnits(doc, rows, units, PAGE.left, doc.y, width); doc.y += (h || 0) + 18;
  }
  if (level === 'rei') {
    ensureSpace(doc, 150, empresa.nome_empresa, periodo, plan, level); const h = drawActionBox(doc, rows, PAGE.left, doc.y, width); doc.y += h + 18; ensureSpace(doc, 120, empresa.nome_empresa, periodo, plan, level); section(doc, 'Detalhamento operacional', 'Sinais objetivos para conferencia manual'); const recentFraud = rows.filter((r) => String(r.fraud_flags || '').trim() && String(r.fraud_flags || '').trim() !== '[]'); kpi(doc, 'Fraude sinalizada', String(recentFraud.length), 'Revisar antes de conclusoes', PAGE.left, doc.y, kw, recentFraud.length ? C.amber : C.blue); kpi(doc, 'Sentimento positivo', String(sent.positive), `${pct(sent.positive, Math.max(sent.positive + sent.neutral + sent.negative, 1))} dos registros`, PAGE.left + kw + gap, doc.y, kw, C.green); kpi(doc, 'Sentimento negativo', String(sent.negative), `${pct(sent.negative, Math.max(sent.positive + sent.neutral + sent.negative, 1))} dos registros`, PAGE.left + (kw + gap) * 2, doc.y, kw, C.red); doc.y += 94;
  }

  ensureSpace(doc, 150, empresa.nome_empresa, periodo, plan, level); section(doc, 'Leitura do periodo', 'Resumo factual - sem previsoes'); const text = total === 0 ? 'Nao houve avaliacoes validas no periodo selecionado. O PDF continua funcional e pronto para receber dados quando novas avaliacoes forem registradas.' : `Foram registradas ${total} avaliacao(oes) validas, com nota media ${avg(rows).toFixed(2)}. ${pos} foram positivas e ${crit} foram criticas.`; doc.roundedRect(PAGE.left, doc.y, width, 72, 7).fillAndStroke(C.paleBlue, C.line); doc.fillColor(C.ink).font('Helvetica').fontSize(9).text(text, PAGE.left + 14, doc.y + 16, { width: width - 28, lineGap: 2, lineBreak: false, height: 42 }); doc.y += 92; doc.fillColor(C.muted).font('Helvetica').fontSize(7.5).text(`Emitido em ${emissao}. Este relatorio reproduz dados registrados no painel e nao cria previsoes.`, PAGE.left, doc.y, { width, lineBreak: false, height: 10 });

  await new Promise<void>((resolve, reject) => { doc.on('end', resolve); doc.on('error', reject); const range = doc.bufferedPageRange(); for (let i = range.start; i < range.start + range.count; i++) { doc.switchToPage(i); drawFooter(doc, empresa.nome_empresa, i - range.start + 1, range.count); } doc.end(); });
  return Buffer.concat(chunks);
}
