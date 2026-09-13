/**
 * PDF via ReportLab (Python) — layout profissional por plano.
 * Fallback: relatorioPdfChromium se Python/reportlab indisponível.
 */
import type { Database } from 'sqlite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { empresaTemPdf, isTrialPlan, planLabel } from './lib/plans.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'pdf', 'reportlab_report.py');

type Review = {
  rating: number;
  unidade_id?: string | null;
  origin?: string | null;
  createdAt?: string | Date;
  created_at?: string | Date;
  createdat?: string | Date;
  is_test?: number | boolean | null;
  ai_tags?: string | null;
  sentiment?: string | null;
};

function isTest(r: Review) {
  return Number(r.is_test) === 1 || r.is_test === true;
}
function rowDate(r: Review): string | null {
  const d = r.createdAt ?? r.created_at ?? r.createdat;
  if (!d) return null;
  return typeof d === 'string' ? d : new Date(d).toISOString();
}
function avg(rs: Review[]) {
  if (!rs.length) return 0;
  return rs.reduce((s, r) => s + Number(r.rating || 0), 0) / rs.length;
}
function dist(rs: Review[]) {
  const a = [0, 0, 0, 0, 0];
  for (const r of rs) {
    const n = Number(r.rating);
    if (n >= 1 && n <= 5) a[n - 1] += 1;
  }
  return a;
}
function sentimentBreak(rs: Review[]) {
  let pos = 0,
    neu = 0,
    neg = 0;
  for (const r of rs) {
    const s = String(r.sentiment || '').toLowerCase();
    if (s.includes('pos')) pos++;
    else if (s.includes('neg')) neg++;
    else if (s.includes('neu')) neu++;
    else {
      const n = Number(r.rating);
      if (n >= 4) pos++;
      else if (n <= 2) neg++;
      else neu++;
    }
  }
  return { pos, neu, neg };
}
function themes(rs: Review[]) {
  const m = new Map<string, number>();
  for (const r of rs) {
    if (!r.ai_tags) continue;
    try {
      const a = JSON.parse(String(r.ai_tags));
      if (Array.isArray(a)) {
        for (const t of a) {
          const k = String(t || '').trim();
          if (k) m.set(k, (m.get(k) || 0) + 1);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));
}

async function loadReviews(db: Database, id: string, month: string): Promise<Review[]> {
  for (const q of [
    `SELECT * FROM reviews WHERE empresa_id = ?`,
    `SELECT rating, is_test, ai_tags, sentiment, unidade_id, origin, created_at FROM reviews WHERE empresa_id = ?`,
  ]) {
    try {
      const rows = (await db.all(q, [id])) as Review[];
      return (rows || []).filter((r) => {
        if (isTest(r)) return false;
        const d = rowDate(r);
        if (!d) return true;
        return d.slice(0, 7) === month;
      });
    } catch {
      /* try next */
    }
  }
  return [];
}

async function loadUnits(db: Database, id: string) {
  try {
    return (await db.all(
      `SELECT id, nome, slug FROM unidades WHERE empresa_id = ? AND (ativo IS NULL OR ativo = 1 OR ativo = true) ORDER BY nome`,
      [id]
    )) as any[];
  } catch {
    return [];
  }
}

function runReportlab(payload: object): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const py = process.env.PYTHON_PATH || process.env.PYTHON || 'python3';
    const child = spawn(py, [SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ReportLab timeout'));
    }, 60_000);

    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const pdf = Buffer.concat(out);
      if (code === 0 && pdf.length > 100 && pdf.subarray(0, 4).toString() === '%PDF') {
        resolve(pdf);
        return;
      }
      reject(
        new Error(
          `ReportLab exit ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 300) || 'sem stderr'}`
        )
      );
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

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
  } catch {
    /* ok */
  }
}

export async function gerarRelatorioMensalPDF(
  db: Database,
  empresaId: string,
  mesAno: string,
  _callGroq?: unknown,
  _lang?: string | null
): Promise<Buffer> {
  const empresa = await db.get('SELECT * FROM empresas WHERE id = ?', [empresaId]);
  if (!empresa) throw new Error('Empresa não encontrada.');
  if (!empresaTemPdf(empresa)) {
    throw new Error('Relatório PDF não disponível neste plano.');
  }

  const plan = String(empresa.plan || empresa.status || 'trial').toLowerCase();
  const trial =
    isTrialPlan(plan) || isTrialPlan(String(empresa.status || ''));
  const depth = trial
    ? 'ultra'
    : plan === 'rei'
      ? 'rei'
      : plan === 'corporativo' || plan === 'corporate'
        ? 'corp'
        : plan === 'ultra'
          ? 'ultra'
          : 'pro';

  const reviews = await loadReviews(db, empresaId, mesAno);
  const unitsRaw =
    depth === 'corp' || depth === 'rei' ? await loadUnits(db, empresaId) : [];

  const total = reviews.length;
  const mean = avg(reviews);
  const positive = reviews.filter((r) => Number(r.rating) >= 4).length;
  const critical = reviews.filter((r) => Number(r.rating) <= 3).length;
  const se = sentimentBreak(reviews);
  const th = themes(reviews);

  const units = unitsRaw
    .map((u) => {
      const list = reviews.filter(
        (r) =>
          String(r.unidade_id || '') === String(u.id) ||
          (u.slug && String(r.origin || '') === String(u.slug))
      );
      return {
        nome: String(u.nome || 'Unidade'),
        total: list.length,
        avg: avg(list),
        critical: list.filter((r) => Number(r.rating) <= 3).length,
        positive: list.filter((r) => Number(r.rating) >= 4).length,
      };
    })
    .filter((u) => u.total > 0)
    .sort((a, b) => b.avg - a.avg || b.total - a.total);

  const payload = {
    empresa_nome: String(empresa.nome_empresa || 'Empresa'),
    plan,
    plan_label: planLabel(plan),
    trial,
    mes: mesAno,
    total,
    avg: mean,
    positive,
    critical,
    dist: dist(reviews),
    sentiment: se,
    themes: th,
    units,
    depth,
  };

  try {
    return await runReportlab(payload);
  } catch (e: any) {
    console.warn('[pdf] ReportLab falhou, tentando Chromium:', e?.message || e);
    const { gerarRelatorioMensalPDF: chromium } = await import('./relatorioPdfChromium.js');
    return chromium(db, empresaId, mesAno, undefined, 'pt-BR');
  }
}
