/**
 * Relatório PDF — Postgres-safe (sem strftime/PRAGMA).
 * Trial + Pro/Ultra/Corp/Rei elegíveis.
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

const C = {
  navy: '#0f172a',
  indigo: '#4f46e5',
  ink: '#1e293b',
  muted: '#64748b',
  line: '#e2e8f0',
  pale: '#f8fafc',
  red: '#dc2626',
  green: '#16a34a',
  white: '#ffffff',
  star: ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'],
};

const PAGE = { left: 44, right: 44 };

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
    console.warn('[pdf] unidades:', e?.message || e);
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
  return reviews.reduce((s, r) => s + Number(r.rating || 0), 0) / reviews.length;
}

function percent(v: number, t: number): string {
  return t ? `${Math.round((v / t) * 100)}%` : '0%';
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
    .slice(0, 8)
    .map(([tag, count]) => ({ tag, count }));
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
        `SELECT rating, comment, is_test, ai_tags, sentiment FROM reviews WHERE empresa_id = ? LIMIT 3000`,
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

export async function gerarRelatorioMensalPDF(
  db: Database,
  empresaId: string,
  mesAno: string,
  _callGroq?: (system: string, user: string) => Promise<string>
): Promise<Buffer> {
  try {
    await ensureUnidadesSchema(db);
  } catch (e: any) {
    console.warn('[pdf] ensure:', e?.message || e);
  }

  const empresa = await db.get('SELECT * FROM empresas WHERE id = ?', [empresaId]);
  if (!empresa) throw new Error('Empresa não encontrada.');

  const plan = String(empresa.plan || empresa.status || 'trial').toLowerCase();
  if (!empresaTemPdf(empresa)) {
    throw new Error('Plano não elegível para relatório mensal.');
  }

  const reviews = await loadReviews(db, empresaId, mesAno).catch(() => [] as ReviewRow[]);
  const trial = isTrialPlan(plan) || isTrialPlan(String(empresa.status || ''));
  const showTags = trial || ['pro', 'ultra', 'corporativo', 'rei'].includes(plan);

  const dist = distNotas(reviews);
  const total = reviews.length;
  const avg = media(reviews);
  const positive = reviews.filter((r) => Number(r.rating) >= 4).length;
  const critical = reviews.filter((r) => Number(r.rating) <= 3).length;
  const tags = showTags ? parseTags(reviews) : [];

  const [ano, mes] = mesAno.split('-');
  const nomesMeses = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
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
    info: { Title: `${nomeEmpresa} — Relatório ${mesAno}`, Author: 'Filtra.AI' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  const w = doc.page.width;
  doc.rect(0, 0, w, 72).fill(C.navy);
  doc.rect(0, 72, w, 3).fill(C.indigo);
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(16).text('Filtra.AI', PAGE.left, 18);
  doc.fillColor('#94a3b8').font('Helvetica').fontSize(8).text('Relatório mensal de reputação', PAGE.left, 40);
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(9).text(pLabel.toUpperCase(), w - 140, 22, {
    width: 96,
    align: 'right',
  });
  doc.fillColor('#94a3b8').font('Helvetica').fontSize(8).text(periodo, w - 140, 38, {
    width: 96,
    align: 'right',
  });

  doc.y = 92;
  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(18).text(nomeEmpresa, PAGE.left);
  doc.moveDown(0.2).fillColor(C.muted).font('Helvetica').fontSize(9).text(`Período: ${periodo}`);
  doc.moveDown(0.7);

  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(12).text('Resumo do período');
  doc.moveDown(0.4);
  const width = w - PAGE.left - PAGE.right;
  const gap = 10;
  const kw = (width - gap * 2) / 3;
  const y = doc.y;

  function kpi(title: string, value: string, desc: string, x: number, accent = C.indigo) {
    doc.roundedRect(x, y, kw, 76, 8).fillAndStroke(C.pale, C.line);
    doc.roundedRect(x, y, 4, 76, 2).fill(accent);
    doc.fillColor(C.indigo).font('Helvetica-Bold').fontSize(7).text(title.toUpperCase(), x + 12, y + 12, {
      width: kw - 20,
    });
    doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(18).text(value, x + 12, y + 28, {
      width: kw - 20,
    });
    doc.fillColor(C.muted).font('Helvetica').fontSize(7.5).text(desc, x + 12, y + 52, {
      width: kw - 20,
    });
  }

  kpi('Volume', String(total), 'Avaliações válidas', PAGE.left);
  kpi('Nota média', avg ? avg.toFixed(1) : '—', 'Escala 1 a 5', PAGE.left + kw + gap);
  kpi('Críticas', String(critical), 'Notas 1–3', PAGE.left + (kw + gap) * 2, C.red);
  doc.y = y + 94;

  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(12).text('Distribuição de notas');
  doc.moveDown(0.35);
  const chartY = doc.y;
  const chartH = 150;
  doc.roundedRect(PAGE.left, chartY, width, chartH, 8).fillAndStroke(C.white, C.line);
  const maxV = Math.max(...dist, 1);
  const barGap = 12;
  const barW = (width - barGap * 6) / 5;
  const top = chartY + 28;
  const h = chartH - 50;
  dist.forEach((v, i) => {
    const barH = (v / maxV) * h;
    const bx = PAGE.left + barGap + i * (barW + barGap);
    const by = top + h - barH;
    doc.roundedRect(bx, by, barW, Math.max(barH, 1), 4).fill(C.star[i]);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(8).text(String(v), bx, by - 12, {
      width: barW,
      align: 'center',
    });
    doc.fillColor(C.muted).font('Helvetica').fontSize(7.5).text(`${i + 1}★`, bx, top + h + 6, {
      width: barW,
      align: 'center',
    });
  });
  doc.y = chartY + chartH + 16;

  doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(12).text('Positivas vs críticas');
  doc.moveDown(0.3);
  doc.fillColor(C.ink).font('Helvetica').fontSize(10).text(
    `Positivas (4–5★): ${positive} (${percent(positive, total)})   ·   Críticas (1–3★): ${critical} (${percent(critical, total)})`,
    { width }
  );
  doc.moveDown(0.8);

  if (tags.length) {
    doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(12).text('Temas da IA');
    doc.moveDown(0.3);
    for (const t of tags) {
      doc.fillColor(C.ink).font('Helvetica').fontSize(9).text(`• ${t.tag} (${t.count})`, { width });
    }
    doc.moveDown(0.5);
  }

  if (total === 0) {
    doc.fillColor(C.muted).font('Helvetica').fontSize(10).text(
      'Nenhuma avaliação neste período. O PDF continua disponível; os números sobem com novos feedbacks.',
      { width }
    );
  }

  doc.fillColor(C.muted).font('Helvetica').fontSize(7.5).text(
    `Emitido em ${emissao}. Dados do painel Filtra.AI.`,
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
