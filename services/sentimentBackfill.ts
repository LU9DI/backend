/**
 * Backfill de sentimento em avaliações antigas (sem sentiment preenchido).
 * Usa heurística por padrão (rápido, sem custo de API).
 * Opcional: useAi=true para refinar com LLM (mais lento/caro).
 */
import type { Database } from 'sqlite';
import { analyzeSentimentHeuristic } from '../lib/sentiment.js';
import { analisarSentimento } from '../groqService.js';

export async function ensureSentimentColumns(db: Database): Promise<void> {
  const cols = (await db.all(`PRAGMA table_info(reviews)`)).map((c: any) => c.name);
  if (!cols.includes('sentiment')) {
    await db.exec(`ALTER TABLE reviews ADD COLUMN sentiment TEXT`);
  }
  if (!cols.includes('sentiment_score')) {
    await db.exec(`ALTER TABLE reviews ADD COLUMN sentiment_score REAL`);
  }
  if (!cols.includes('sentiment_source')) {
    await db.exec(`ALTER TABLE reviews ADD COLUMN sentiment_source TEXT`);
  }
}

export type BackfillOptions = {
  /** Processar no máximo N linhas por execução (default 2000) */
  limit?: number;
  /** Usar IA (default false) */
  useAi?: boolean;
  /** Só empresa específica */
  empresaId?: string;
  /** Reprocessar mesmo se já tiver sentiment */
  force?: boolean;
};

export type BackfillResult = {
  scanned: number;
  updated: number;
  skipped: number;
  errors: number;
  duration_ms: number;
};

export async function backfillSentiment(
  db: Database,
  opts: BackfillOptions = {}
): Promise<BackfillResult> {
  const t0 = Date.now();
  await ensureSentimentColumns(db);

  const limit = Math.max(1, Math.min(opts.limit ?? 2000, 50_000));
  const useAi = Boolean(opts.useAi);
  const force = Boolean(opts.force);

  let sql = `SELECT id, rating, comment, sentiment FROM reviews`;
  const params: unknown[] = [];
  const where: string[] = [];

  if (!force) {
    where.push(`(sentiment IS NULL OR sentiment = '')`);
  }
  if (opts.empresaId) {
    where.push(`empresa_id = ?`);
    params.push(opts.empresaId);
  }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ` ORDER BY id ASC LIMIT ?`;
  params.push(limit);

  const rows = (await db.all(sql, params)) as {
    id: number;
    rating: number;
    comment: string | null;
    sentiment: string | null;
  }[];

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      if (!force && row.sentiment) {
        skipped += 1;
        continue;
      }

      const rating = Number(row.rating) || 3;
      const comment = row.comment || '';

      const result = useAi
        ? await analisarSentimento(rating, comment, true)
        : analyzeSentimentHeuristic(rating, comment);

      await db.run(
        `UPDATE reviews
         SET sentiment = ?, sentiment_score = ?, sentiment_source = ?
         WHERE id = ?`,
        [result.label, result.score, result.source, row.id]
      );
      updated += 1;
    } catch (e: any) {
      errors += 1;
      console.warn(`[backfill-sentiment] id=${row.id}:`, e?.message || e);
    }
  }

  return {
    scanned: rows.length,
    updated,
    skipped,
    errors,
    duration_ms: Date.now() - t0,
  };
}

/** Conta quantas reviews ainda sem sentimento */
export async function countMissingSentiment(db: Database): Promise<number> {
  await ensureSentimentColumns(db);
  const row = await db.get(
    `SELECT COUNT(*) as c FROM reviews WHERE sentiment IS NULL OR sentiment = ''`
  );
  return Number(row?.c || 0);
}
