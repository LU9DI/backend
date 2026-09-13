/** Relatório executivo via WhatsApp: dados consolidados -> IA -> cache. */
import crypto from 'crypto';
import type { Database } from 'sqlite';
import { callAI } from '../groqService.js';

export type ReportPeriod = {
  tipo: 'semana' | 'mes';
  inicio: string;
  fim: string;
  chave: string;
};

type ConsolidatedReportData = {
  cliente_id: string;
  periodo_inicio: string;
  periodo_fim: string;
  score_medio: number | null;
  total_avaliacoes: number;
  variacao_score: number | null;
  top_elogios: string[];
  top_reclamacoes: string[];
};

type CacheRow = {
  cliente_id: string;
  periodo_tipo: string;
  periodo_inicio: string;
  periodo_fim: string;
  chave_periodo: string;
  dados_hash: string | null;
  texto_relatorio: string | null;
  modelo_ia: string | null;
  status: string;
  generation_started_at: string | null;
};

const GENERATION_TIMEOUT_MS = 10 * 60 * 1000;
const WAIT_MS = 250;
const WAIT_ATTEMPTS = 40;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function buildReportPeriod(
  tipoRaw?: string | null,
  inicioRaw?: string | null,
  fimRaw?: string | null
): ReportPeriod {
  const tipo = String(tipoRaw || 'semana').toLowerCase() === 'mes' ? 'mes' : 'semana';

  if (inicioRaw || fimRaw) {
    if (!inicioRaw || !fimRaw) throw new Error('Informe inicio e fim do período.');
    const inicio = parseDate(inicioRaw);
    const fim = parseDate(fimRaw);
    if (!inicio || !fim || inicio > fim) throw new Error('Período inválido. Use datas YYYY-MM-DD.');
    if (fim.getTime() - inicio.getTime() > 366 * 24 * 60 * 60 * 1000) {
      throw new Error('Período máximo permitido: 366 dias.');
    }
    return { tipo, inicio: isoDate(inicio), fim: isoDate(fim), chave: `${isoDate(inicio)}_${isoDate(fim)}` };
  }

  const now = new Date();
  if (tipo === 'mes') {
    const inicio = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const fim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    return { tipo, inicio: isoDate(inicio), fim: isoDate(fim), chave: `${isoDate(inicio)}_${isoDate(fim)}` };
  }

  const day = now.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const inicio = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + mondayOffset));
  const fim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + mondayOffset + 6));
  return { tipo, inicio: isoDate(inicio), fim: isoDate(fim), chave: `${isoDate(inicio)}_${isoDate(fim)}` };
}

export async function ensureReportCacheSchema(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS relatorios_cache (
      id TEXT PRIMARY KEY,
      cliente_id TEXT NOT NULL,
      periodo_tipo TEXT NOT NULL,
      periodo_inicio TEXT NOT NULL,
      periodo_fim TEXT NOT NULL,
      chave_periodo TEXT NOT NULL,
      dados_hash TEXT,
      texto_relatorio TEXT,
      modelo_ia TEXT,
      status TEXT NOT NULL DEFAULT 'generating',
      generation_started_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (cliente_id, periodo_inicio, periodo_fim)
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_relatorios_cache_cliente ON relatorios_cache(cliente_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_relatorios_cache_periodo ON relatorios_cache(chave_periodo)`);
}

async function getCache(db: Database, clienteId: string, period: ReportPeriod): Promise<CacheRow | undefined> {
  return db.get<CacheRow>(
    `SELECT cliente_id, periodo_tipo, periodo_inicio, periodo_fim, chave_periodo,
            dados_hash, texto_relatorio, modelo_ia, status, generation_started_at
       FROM relatorios_cache
      WHERE cliente_id = ? AND periodo_inicio = ? AND periodo_fim = ?`,
    [clienteId, period.inicio, period.fim]
  );
}

function hashData(data: ConsolidatedReportData): string {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

function parseTags(value: unknown): string[] {
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .slice(0, 10);
  } catch {
    return [];
  }
}

function topTags(rows: Array<{ ai_tags?: unknown }>): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const tag of parseTags(row.ai_tags)) {
      const key = tag.slice(0, 80);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);
}

async function consolidateData(db: Database, clienteId: string, period: ReportPeriod): Promise<ConsolidatedReportData> {
  const start = `${period.inicio}T00:00:00.000Z`;
  const endExclusiveDate = new Date(`${period.fim}T00:00:00.000Z`);
  endExclusiveDate.setUTCDate(endExclusiveDate.getUTCDate() + 1);
  const endExclusive = endExclusiveDate.toISOString();

  const current = await db.get<{ avg: number | null; total: number }>(
    `SELECT AVG(rating) AS avg, COUNT(*) AS total
       FROM reviews
      WHERE empresa_id = ?
        AND createdAt >= ?
        AND createdAt < ?
        AND IFNULL(is_test, 0) = 0`,
    [clienteId, start, endExclusive]
  );

  const previousEnd = new Date(`${period.inicio}T00:00:00.000Z`);
  const durationMs = endExclusiveDate.getTime() - previousEnd.getTime();
  const previousStart = new Date(previousEnd.getTime() - durationMs);
  const previous = await db.get<{ avg: number | null }>(
    `SELECT AVG(rating) AS avg
       FROM reviews
      WHERE empresa_id = ?
        AND createdAt >= ?
        AND createdAt < ?
        AND IFNULL(is_test, 0) = 0`,
    [clienteId, previousStart.toISOString(), start]
  );

  const tagRows = await db.all<{ ai_tags?: string | null }>(
    `SELECT ai_tags
       FROM reviews
      WHERE empresa_id = ?
        AND createdAt >= ?
        AND createdAt < ?
        AND IFNULL(is_test, 0) = 0
        AND ai_tags IS NOT NULL
      ORDER BY createdAt DESC
      LIMIT 500`,
    [clienteId, start, endExclusive]
  );

  const positiveRows = await db.all<{ ai_tags?: string | null }>(
    `SELECT ai_tags
       FROM reviews
      WHERE empresa_id = ?
        AND createdAt >= ?
        AND createdAt < ?
        AND IFNULL(is_test, 0) = 0
        AND rating >= 4
        AND ai_tags IS NOT NULL
      ORDER BY createdAt DESC
      LIMIT 300`,
    [clienteId, start, endExclusive]
  );

  const negativeRows = await db.all<{ ai_tags?: string | null }>(
    `SELECT ai_tags
       FROM reviews
      WHERE empresa_id = ?
        AND createdAt >= ?
        AND createdAt < ?
        AND IFNULL(is_test, 0) = 0
        AND rating <= 3
        AND ai_tags IS NOT NULL
      ORDER BY createdAt DESC
      LIMIT 300`,
    [clienteId, start, endExclusive]
  );

  const currentAvg = current?.avg == null ? null : Number(current.avg);
  const previousAvg = previous?.avg == null ? null : Number(previous.avg);

  return {
    cliente_id: clienteId,
    periodo_inicio: period.inicio,
    periodo_fim: period.fim,
    score_medio: Number.isFinite(currentAvg as number) ? Number(currentAvg!.toFixed(2)) : null,
    total_avaliacoes: Number(current?.total || 0),
    variacao_score:
      currentAvg != null && previousAvg != null
        ? Number((currentAvg - previousAvg).toFixed(2))
        : null,
    top_elogios: topTags(positiveRows.length ? positiveRows : tagRows),
    top_reclamacoes: topTags(negativeRows),
  };
}

function sanitizeWhatsApp(text: string): string {
  let out = String(text || '').trim();
  out = out.replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, '');
  out = out.replace(/^\s*(?:json|markdown)\s*$/gim, '');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.slice(0, 3500).trim();
}

function buildPrompt(data: ConsolidatedReportData): { system: string; user: string } {
  const system = [
    'Você é o analista executivo de reputação do Filtra.IA.',
    'Analise SOMENTE os dados JSON fornecidos pelo sistema.',
    'Não invente números, métricas, avaliações, nomes, causas ou informações ausentes.',
    'Se um dado estiver ausente, simplesmente não mencione esse dado.',
    'Destaque evolução positiva ou negativa somente quando variacao_score estiver disponível.',
    'Use linguagem profissional, clara, objetiva e útil para um empresário.',
    'Não mencione IA, banco de dados, JSON, sistema, prompt ou processo interno.',
    'Retorne APENAS texto pronto para WhatsApp.',
    'Use somente *negrito*, _itálico_, ~riscado~, listas com • e emojis.',
    'Não use HTML, tabelas, links, código ou Markdown complexo.',
    'Estruture em: título, KPIs disponíveis, elogios disponíveis, pontos de atenção disponíveis e conclusão curta.',
    'Se não houver elogios ou reclamações, não crie uma seção para isso.',
    'Se não houver avaliações, informe que não houve avaliações no período e não invente uma análise.',
  ].join('\n');

  return { system, user: JSON.stringify(data) };
}

async function claimGeneration(db: Database, clienteId: string, period: ReportPeriod): Promise<boolean> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const result = await db.run(
    `INSERT INTO relatorios_cache
      (id, cliente_id, periodo_tipo, periodo_inicio, periodo_fim, chave_periodo, status, generation_started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'generating', ?, ?, ?)
     ON CONFLICT (cliente_id, periodo_inicio, periodo_fim) DO NOTHING`,
    [id, clienteId, period.tipo, period.inicio, period.fim, period.chave, now, now, now]
  );
  return Number(result.changes || 0) > 0;
}

async function waitForGeneration(db: Database, clienteId: string, period: ReportPeriod): Promise<CacheRow | undefined> {
  for (let i = 0; i < WAIT_ATTEMPTS; i++) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    const row = await getCache(db, clienteId, period);
    if (row?.status === 'ready' && row.texto_relatorio) return row;
  }
  return getCache(db, clienteId, period);
}

async function recoverStaleGeneration(db: Database, row: CacheRow, period: ReportPeriod): Promise<void> {
  if (row.status !== 'generating' || !row.generation_started_at) return;
  const started = Date.parse(row.generation_started_at);
  if (!Number.isFinite(started) || Date.now() - started <= GENERATION_TIMEOUT_MS) return;
  await db.run(
    `DELETE FROM relatorios_cache
      WHERE cliente_id = ? AND periodo_inicio = ? AND periodo_fim = ? AND status = 'generating'`,
    [row.cliente_id, period.inicio, period.fim]
  );
}

export async function getOrGenerateWhatsAppReport(
  db: Database,
  clienteId: string,
  period: ReportPeriod
): Promise<{ text: string; cached: boolean; model: string; data: ConsolidatedReportData }> {
  await ensureReportCacheSchema(db);

  let row = await getCache(db, clienteId, period);
  if (row?.status === 'ready' && row.texto_relatorio) {
    const data = await consolidateData(db, clienteId, period);
    return { text: row.texto_relatorio, cached: true, model: row.modelo_ia || 'cached', data };
  }

  if (row?.status === 'generating') {
    await recoverStaleGeneration(db, row, period);
    row = await getCache(db, clienteId, period);
    if (row?.status === 'generating') {
      const waited = await waitForGeneration(db, clienteId, period);
      if (waited?.status === 'ready' && waited.texto_relatorio) {
        const data = await consolidateData(db, clienteId, period);
        return { text: waited.texto_relatorio, cached: true, model: waited.modelo_ia || 'cached', data };
      }
      throw new Error('Geração do relatório já está em andamento. Tente novamente em instantes.');
    }
  }

  const owner = await claimGeneration(db, clienteId, period);
  if (!owner) {
    const waited = await waitForGeneration(db, clienteId, period);
    if (waited?.status === 'ready' && waited.texto_relatorio) {
      const data = await consolidateData(db, clienteId, period);
      return { text: waited.texto_relatorio, cached: true, model: waited.modelo_ia || 'cached', data };
    }
    throw new Error('Geração do relatório já está em andamento. Tente novamente em instantes.');
  }

  try {
    const data = await consolidateData(db, clienteId, period);
    const dataHash = hashData(data);
    const prompt = buildPrompt(data);
    const ai = await callAI(prompt.system, prompt.user, 260, 0.3, {
      empresaId: clienteId,
      tipo: 'whatsapp_report',
    });
    const text = sanitizeWhatsApp(ai.text);
    if (!text) throw new Error('IA retornou relatório vazio.');

    await db.run(
      `UPDATE relatorios_cache
          SET dados_hash = ?, texto_relatorio = ?, modelo_ia = ?, status = 'ready', updated_at = ?
        WHERE cliente_id = ? AND periodo_inicio = ? AND periodo_fim = ?`,
      [
        dataHash,
        text,
        `${ai.provider}:${process.env[ai.provider === 'groq' ? 'GROQ_MODEL' : 'GEMINI_MODEL'] || 'default'}`,
        new Date().toISOString(),
        clienteId,
        period.inicio,
        period.fim,
      ]
    );

    return { text, cached: false, model: ai.provider, data };
  } catch (error) {
    await db.run(
      `DELETE FROM relatorios_cache
        WHERE cliente_id = ? AND periodo_inicio = ? AND periodo_fim = ? AND status = 'generating'`,
      [clienteId, period.inicio, period.fim]
    );
    throw error;
  }
}
