import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Database } from 'sqlite';
import { planTemPdf } from '../lib/plans.js';
import { ensureMonthlyReportSchema, monthlyReportExists, saveMonthlyReport } from '../lib/monthlyReportStore.js';
import type { ReportCycle } from '../lib/reportCycle.js';

const execFileAsync = promisify(execFile);

function normalizeLang(raw: unknown): 'pt-BR' | 'en-US' | 'es-ES' | 'zh-CN' {
  const s = String(raw || 'pt').toLowerCase();
  if (s.startsWith('en')) return 'en-US';
  if (s.startsWith('es')) return 'es-ES';
  if (s.startsWith('zh')) return 'zh-CN';
  return 'pt-BR';
}

function depthForPlan(planRaw: string): 'pro' | 'ultra' | 'corporativo' | 'rei' {
  const p = String(planRaw || '').toLowerCase();
  if (p === 'trial' || p === 'rei' || p === 'rei-anual') return 'rei';
  if (p === 'corporativo' || p === 'corporate') return 'corporativo';
  if (p === 'ultra' || p === 'ultra-anual') return 'ultra';
  return 'pro';
}

function cycleLabel(cycle: ReportCycle): string {
  const f = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
  return `${f(cycle.start)} — ${f(cycle.endInclusive)}`;
}

function percentage(value: number, total: number): string {
  return total ? `${((value / total) * 100).toFixed(1)}%` : '0.0%';
}

async function runReportLab(payload: unknown): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'filtra-report-'));
  const input = path.join(dir, 'input.json');
  const output = path.join(dir, 'report.pdf');
  const script = path.resolve(process.cwd(), 'pdf', 'relatorioPdf.py');
  await fs.writeFile(input, JSON.stringify(payload), 'utf8');

  try {
    const python = process.env.PYTHON_BIN || 'python3';
    await execFileAsync(python, [script, input, output], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    const pdf = await fs.readFile(output);
    if (pdf.length < 100 || pdf.subarray(0, 5).toString() !== '%PDF-') {
      throw new Error('ReportLab retornou um arquivo PDF inválido.');
    }
    return pdf;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function generateMonthlyReport(
  db: Database,
  empresa: any,
  cycle: ReportCycle
): Promise<{ pdf: Buffer; cycleKey: string; fileName: string; alreadyExists: boolean }> {
  await ensureMonthlyReportSchema(db);

  const plan = String(empresa.plan || '').toLowerCase();
  if (!planTemPdf(plan)) throw new Error(`Plano ${plan} não possui relatório PDF.`);

  if (await monthlyReportExists(db, empresa.id, cycle.key)) {
    return {
      pdf: Buffer.alloc(0),
      cycleKey: cycle.key,
      fileName: `relatorio-${empresa.slug || empresa.id}-${cycle.key}.pdf`,
      alreadyExists: true,
    };
  }

  const cols = (await db.all(`PRAGMA table_info(reviews)`)).map((c: any) => c.name);
  if (!cols.includes('is_test')) await db.exec(`ALTER TABLE reviews ADD COLUMN is_test INTEGER DEFAULT 0`);
  if (!cols.includes('sentiment')) await db.exec(`ALTER TABLE reviews ADD COLUMN sentiment TEXT`);
  if (!cols.includes('ai_tags')) await db.exec(`ALTER TABLE reviews ADD COLUMN ai_tags TEXT`);
  if (!cols.includes('unidade_id')) await db.exec(`ALTER TABLE reviews ADD COLUMN unidade_id TEXT`);

  const reviews = await db.all(
    `SELECT rating, comment, sentiment, ai_tags, unidade_id
       FROM reviews
      WHERE empresa_id = ?
        AND createdAt >= ?
        AND createdAt < ?
        AND IFNULL(is_test, 0) = 0
        AND rating BETWEEN 1 AND 5
      ORDER BY createdAt ASC`,
    [empresa.id, cycle.start.toISOString(), cycle.endExclusive.toISOString()]
  );

  const total = reviews.length;
  const positive = reviews.filter((r: any) => Number(r.rating) >= 4).length;
  const neutral = reviews.filter((r: any) => Number(r.rating) === 3).length;
  const negative = reviews.filter((r: any) => Number(r.rating) <= 2).length;
  const critical = reviews.filter((r: any) => Number(r.rating) <= 3).length;
  const average = total
    ? (reviews.reduce((sum: number, r: any) => sum + Number(r.rating), 0) / total).toFixed(2)
    : '—';

  const depth = depthForPlan(plan);
  const includeAi = depth !== 'pro';
  const includeUnits = depth === 'corporativo' || depth === 'rei';

  const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
  const themeCounts = new Map<string, number>();

  for (const r of reviews as any[]) {
    const s = String(r.sentiment || '').toLowerCase();
    if (s.includes('positivo')) sentimentCounts.positive++;
    else if (s.includes('negativo')) sentimentCounts.negative++;
    else if (s.includes('neutro')) sentimentCounts.neutral++;

    if (includeAi && r.ai_tags) {
      try {
        const parsed = JSON.parse(r.ai_tags);
        const tags = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.keywords)
            ? parsed.keywords
            : Array.isArray(parsed?.tags)
              ? parsed.tags
              : [];
        for (const tag of tags) {
          const key = String(tag || '').trim();
          if (key) themeCounts.set(key, (themeCounts.get(key) || 0) + 1);
        }
      } catch {
        // ai_tags antigos podem não estar em JSON.
      }
    }
  }

  const sentimentTotal = sentimentCounts.positive + sentimentCounts.neutral + sentimentCounts.negative;
  const sentiment = sentimentTotal
    ? {
        positive: sentimentCounts.positive,
        neutral: sentimentCounts.neutral,
        negative: sentimentCounts.negative,
        positivePct: percentage(sentimentCounts.positive, sentimentTotal),
        neutralPct: percentage(sentimentCounts.neutral, sentimentTotal),
        negativePct: percentage(sentimentCounts.negative, sentimentTotal),
      }
    : null;

  let units: any[] = [];
  if (includeUnits) {
    const unitRows = await db.all(
      `SELECT id, nome FROM unidades WHERE empresa_id = ? AND IFNULL(ativo,1) = 1 ORDER BY nome`,
      [empresa.id]
    );
    const byUnit = new Map<string, any>();
    for (const r of reviews as any[]) {
      if (!r.unidade_id) continue;
      if (!byUnit.has(r.unidade_id)) byUnit.set(r.unidade_id, []);
      byUnit.get(r.unidade_id).push(r);
    }
    units = unitRows
      .map((u: any) => {
        const rs = byUnit.get(u.id) || [];
        if (!rs.length) return null;
        return {
          name: u.nome,
          reviews: rs.length,
          average: (rs.reduce((s: number, r: any) => s + Number(r.rating), 0) / rs.length).toFixed(2),
        };
      })
      .filter(Boolean);
  }

  const themes = [...themeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  const payload = {
    language: normalizeLang(empresa.locale),
    companyName: empresa.nome_empresa,
    period: cycleLabel(cycle),
    plan: plan || 'trial',
    kpis: { reviews: total, average, critical },
    distribution: {
      positive,
      neutral,
      negative,
      positivePct: percentage(positive, total),
      neutralPct: percentage(neutral, total),
      negativePct: percentage(negative, total),
    },
    includeSentiment: includeAi && Boolean(sentiment),
    includeThemes: includeAi && themes.length > 0,
    includeUnits: includeUnits && units.length > 0,
    sentiment,
    themes,
    units,
    conclusion:
      total > 0
        ? `Período encerrado com ${total} avaliação(ões) e nota média ${average}.`
        : null,
  };

  const pdf = await runReportLab(payload);
  const fileName = `relatorio-${empresa.slug || empresa.id}-${cycle.key}.pdf`;

  await saveMonthlyReport(db, {
    id: crypto.randomUUID(),
    empresaId: empresa.id,
    cycleKey: cycle.key,
    cycleStart: cycle.start.toISOString(),
    cycleEnd: cycle.endInclusive.toISOString(),
    plan,
    status: 'generated',
    fileName,
    bytes: pdf.length,
    pdfData: pdf,
  });

  return { pdf, cycleKey: cycle.key, fileName, alreadyExists: false };
}
