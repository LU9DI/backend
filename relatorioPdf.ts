/**
 * Relatório mensal PDF — Postgres + SQLite, resiliente.
 * Trial e Pro+ elegíveis. Filtro de mês em JS se o SQL de data falhar.
 */
import type { Database } from 'sqlite';
import PDFDocument from 'pdfkit';
import { empresaTemPdf, isTrialPlan } from './lib/plans.js';

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

const COLORS = {
  navy: '#17233c',
  blue: '#4f46e5',
  ink: '#26364d',
  muted: '#65748a',
  line: '#d9e1eb',
  pale: '#f5f7fa',
  red: '#b42318',
  white: '#ffffff',
  star: ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'],
};

const PAGE = { left: 42, right: 42, bottom: 46 };

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
          const key = String(tag).trim();
          if (key) counts[key] = (counts[key] || 0) + 1;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag, count]) => ({ tag, count }));
}

/** Carrega reviews do mês — nunca derruba o PDF por erro de SQL. */
async function loadReviews(
  db: Database,
  empresaId: string,
  mesAno: string
): Promise<ReviewRow[]> {
  let rows: any[] = [];

  try {
    rows = (await db.all(
      `SELECT * FROM reviews WHERE empresa_id = ? ORDER BY id DESC LIMIT 2000`,
      [empresaId]
    )) as any[];
  } catch (e: any) {
    console.warn('[pdf] SELECT * reviews falhou:', e?.message || e);
    try {
      rows = (await db.all(
        `SELECT rating, comment, is_test, ai_tags, sentiment FROM reviews WHERE empresa_id = ? LIMIT 2000`,
        [empresaId]
      )) as any[];
    } catch (e2: any) {
      console.warn('[pdf] SELECT mínimo falhou:', e2?.message || e2);
      return [];
    }
  }

  const list = (rows || []).filter((r) => !isTest(r as ReviewRow));
  // Filtra mês em JS (evita strftime / to_char / aspas de coluna)
  return list.filter((r) => {
    const d = rowDate(r as ReviewRow);
    if (!d) return true; // sem data: inclui para não zerar o relatório por coluna estranha
    return d.startsWith(mesAno);
  }) as ReviewRow[];
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

  let reviews: ReviewRow[] = [];
  try {
    reviews = await loadReviews(db, empresaId, mesAno);
  } catch (e: any) {
    console.warn('[pdf] loadReviews:', e?.message || e);
    reviews = [];
  }

  const trial = isTrialPlan(plan) || isTrialPlan(String(empresa.status || ''));
  const ultraPlus =
    trial || plan === 'pro' || plan === 'ultra' || plan === 'corporativo' || plan === 'rei';

  const dist = distNotas(reviews);
  const total = reviews.length;
  const avg = media(reviews);
  const positive = reviews.filter((r) => Number(r.rating) >= 4).length;
  const critical = reviews.filter((r) => Number(r.rating) <= 3).length;
  const tags = ultraPlus ? parseTags(reviews) : [];

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
  const planLabel = trial ? 'TRIAL' : plan.toUpperCase();
  const nomeEmpresa = String(empresa.nome_empresa || 'Empresa');

  const doc = new PDFDocument({
    size: 'A4',
    margin: PAGE.left,
    bufferPages: true,
    info: { Title: `${nomeEmpresa} — Relatório ${mesAno}`, Author: 'Filtra.IA' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  doc.rect(0, 0, doc.page.width, 78).fill(COLORS.navy);
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(18).text('FILTRA.AI', PAGE.left, 20);
  doc
    .fillColor('#c7d2e5')
    .font('Helvetica')
    .fontSize(8.5)
    .text('Relatório mensal · dados do painel', PAGE.left, 46);
  doc
    .fillColor(COLORS.white)
    .font('Helvetica-Bold')
    .fontSize(8)
    .text(planLabel, doc.page.width - 132, 23, { width: 90, align: 'right' });
  doc
    .fillColor('#c7d2e5')
    .font('Helvetica')
    .fontSize(7.5)
    .text(periodo, doc.page.width - 132, 40, { width: 90, align: 'right' });

  doc.y = 98;
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(18).text(nomeEmpresa, PAGE.left, doc.y);
  doc
    .moveDown(0.15)
    .fillColor(COLORS.muted)
    .font('Helvetica')
    .fontSize(8)
    .text(`Período analisado: ${periodo}`);
  doc.moveDown(0.8);

  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(13).text('Resumo do período');
  doc.moveDown(0.4);
  const width = doc.page.width - PAGE.left - PAGE.right;
  const gap = 10;
  const kw = (width - gap * 2) / 3;
  const y = doc.y;

  function kpi(title: string, value: string, desc: string, x: number, accent = COLORS.blue) {
    doc.roundedRect(x, y, kw, 76, 7).fillAndStroke(COLORS.pale, COLORS.line);
    doc.roundedRect(x, y, 4, 76, 2).fill(accent);
    doc
      .fillColor(COLORS.blue)
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .text(title.toUpperCase(), x + 12, y + 10, { width: kw - 20 });
    doc
      .fillColor(COLORS.navy)
      .font('Helvetica-Bold')
      .fontSize(18)
      .text(value, x + 12, y + 28, { width: kw - 20 });
    doc
      .fillColor(COLORS.muted)
      .font('Helvetica')
      .fontSize(7.5)
      .text(desc, x + 12, y + 52, { width: kw - 20 });
  }

  kpi('Volume', String(total), 'Avaliações válidas', PAGE.left);
  kpi('Nota média', avg ? avg.toFixed(1) : '—', 'Escala 1 a 5', PAGE.left + kw + gap);
  kpi('Críticas', String(critical), 'Notas 1–3', PAGE.left + (kw + gap) * 2, COLORS.red);
  doc.y = y + 94;

  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(13).text('Distribuição de notas');
  doc.moveDown(0.35);
  const chartY = doc.y;
  const chartH = 150;
  doc.roundedRect(PAGE.left, chartY, width, chartH, 7).fillAndStroke(COLORS.white, COLORS.line);
  const maxV = Math.max(...dist, 1);
  const barGap = 12;
  const barW = (width - barGap * 6) / 5;
  const top = chartY + 28;
  const h = chartH - 50;
  dist.forEach((v, i) => {
    const barH = (v / maxV) * h;
    const bx = PAGE.left + barGap + i * (barW + barGap);
    const by = top + h - barH;
    doc.roundedRect(bx, by, barW, Math.max(barH, 1), 4).fill(COLORS.star[i]);
    doc
      .fillColor(COLORS.ink)
      .font('Helvetica-Bold')
      .fontSize(8)
      .text(String(v), bx, by - 12, { width: barW, align: 'center' });
    doc
      .fillColor(COLORS.muted)
      .font('Helvetica')
      .fontSize(7.5)
      .text(`${i + 1}★`, bx, top + h + 6, { width: barW, align: 'center' });
  });
  doc.y = chartY + chartH + 16;

  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(13).text('Positivas vs críticas');
  doc.moveDown(0.3);
  doc
    .fillColor(COLORS.ink)
    .font('Helvetica')
    .fontSize(10)
    .text(
      `Positivas (4–5★): ${positive} (${percent(positive, total)})   ·   Críticas (1–3★): ${critical} (${percent(critical, total)})`,
      { width }
    );
  doc.moveDown(0.8);

  if (ultraPlus && tags.length) {
    doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(13).text('Temas registrados pela IA');
    doc.moveDown(0.3);
    for (const t of tags) {
      doc.fillColor(COLORS.ink).font('Helvetica').fontSize(9).text(`• ${t.tag} (${t.count})`, { width });
    }
    doc.moveDown(0.6);
  }

  if (total === 0) {
    doc
      .fillColor(COLORS.muted)
      .font('Helvetica')
      .fontSize(10)
      .text(
        'Nenhuma avaliação válida neste período. O relatório continua disponível; os números sobem quando houver feedbacks.',
        { width }
      );
    doc.moveDown(0.6);
  }

  doc
    .fillColor(COLORS.muted)
    .font('Helvetica')
    .fontSize(7.5)
    .text(
      `Emitido em ${emissao}. Dados do painel Filtra.IA — sem previsão de resultados futuros.`,
      PAGE.left,
      doc.page.height - 40,
      { width }
    );

  await new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', (err) => reject(err));
    doc.end();
  });

  const buf = Buffer.concat(chunks);
  if (!buf.length) throw new Error('PDF gerado vazio');
  return buf;
}
