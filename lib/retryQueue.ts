/**
 * Fila de retry persistente (SQLite/PostgreSQL via adapter) com backoff exponencial.
 *
 * Tipos comuns:
 *   paypal_webhook | email | capture_paypal | generic
 *
 * Env:
 *   RETRY_MAX_ATTEMPTS=8
 *   RETRY_BASE_MS=30000
 *   RETRY_WORKER_INTERVAL_MS=60000
 */
import type { Database } from 'sqlite';
import { getDb } from './db.js';

export type RetryJobType =
  | 'paypal_webhook'
  | 'email'
  | 'capture_paypal'
  | 'generic'
  | string;

export async function ensureRetryQueue(db: Database = getDb()) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS retry_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 8,
      next_run_at TEXT NOT NULL,
      last_error TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      dedupe_key TEXT,
      processing_at TEXT
    );
  `);
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_retry_pending ON retry_queue(status, next_run_at)`
  );
  try {
    await db.exec(`ALTER TABLE retry_queue ADD COLUMN processing_at TEXT`);
  } catch {
    /* coluna já existe */
  }
  await db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_retry_dedupe ON retry_queue(dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'pending'`
  ).catch(() => {
    /* SQLite partial unique pode falhar em versões antigas — ignora */
  });
}

function maxAttempts(): number {
  return Math.max(1, Number(process.env.RETRY_MAX_ATTEMPTS || 8));
}

function baseMs(): number {
  return Math.max(1000, Number(process.env.RETRY_BASE_MS || 30_000));
}

/** backoff: base * 2^attempt (+ jitter), teto 6h */
export function nextBackoffIso(attempts: number): string {
  const exp = Math.min(attempts, 10);
  const ms = Math.min(6 * 60 * 60 * 1000, baseMs() * Math.pow(2, exp));
  const jitter = Math.floor(Math.random() * Math.min(5000, ms * 0.1));
  return new Date(Date.now() + ms + jitter).toISOString();
}

export async function enqueueRetry(
  opts: {
    jobType: RetryJobType;
    payload: Record<string, unknown>;
    dedupeKey?: string | null;
    maxAttempts?: number;
    delayMs?: number;
  },
  db: Database = getDb()
): Promise<number> {
  await ensureRetryQueue(db);
  const next =
    opts.delayMs && opts.delayMs > 0
      ? new Date(Date.now() + opts.delayMs).toISOString()
      : new Date().toISOString();

  if (opts.dedupeKey) {
    const existing = await db.get(
      `SELECT id FROM retry_queue WHERE dedupe_key = ? AND status = 'pending'`,
      [opts.dedupeKey]
    );
    if (existing?.id) return Number(existing.id);
  }

  // Use INSERT ... RETURNING so the queue works with both SQLite and
  // PostgreSQL. The PostgreSQL adapter intentionally does not expose lastID.
  // The SELECT above is only an optimization: two concurrent requests can both
  // observe no row and race on the unique partial index. Treat that constraint
  // race as a successful dedupe instead of surfacing a 500/retry-loop.
  try {
    const inserted = await db.get<{ id: number | string }>(
      `INSERT INTO retry_queue (job_type, payload, attempts, max_attempts, next_run_at, status, dedupe_key)
       VALUES (?, ?, 0, ?, ?, 'pending', ?)
       RETURNING id`,
      [
        opts.jobType,
        JSON.stringify(opts.payload),
        opts.maxAttempts ?? maxAttempts(),
        next,
        opts.dedupeKey || null,
      ]
    );
    if (!inserted?.id) {
      throw new Error('retry_queue: não foi possível obter o id do job inserido');
    }
    return Number(inserted.id);
  } catch (error: any) {
    if (opts.dedupeKey) {
      const message = String(error?.message || error || '');
      const isUniqueViolation =
        /duplicate key|unique constraint|unique violation|already exists/i.test(message);
      if (isUniqueViolation) {
        const existing = await db.get(
          `SELECT id FROM retry_queue WHERE dedupe_key = ? AND status = 'pending'`,
          [opts.dedupeKey]
        );
        if (existing?.id) return Number(existing.id);
      }
    }
    throw error;
  }
}

type Handler = (payload: any, job: any) => Promise<void>;

const handlers = new Map<string, Handler>();

export function registerRetryHandler(jobType: string, handler: Handler) {
  handlers.set(jobType, handler);
}

export async function processRetryQueue(
  db: Database = getDb(),
  limit = 20
): Promise<{ processed: number; ok: number; failed: number; dead: number }> {
  await ensureRetryQueue(db);
  const agora = new Date().toISOString();
  const stale = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  await db.run(
    `UPDATE retry_queue SET status = 'pending', processing_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE status = 'processing' AND processing_at IS NOT NULL AND processing_at <= ?`,
    [stale]
  );
  const rows = await db.all(
    `SELECT * FROM retry_queue
     WHERE status = 'pending' AND next_run_at <= ?
     ORDER BY next_run_at ASC
     LIMIT ?`,
    [agora, limit]
  );

  let ok = 0;
  let failed = 0;
  let dead = 0;

  for (const job of rows || []) {
    const claimed = await db.run(
      `UPDATE retry_queue SET status = 'processing', processing_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'pending' AND next_run_at <= ?`,
      [agora, job.id, agora]
    );
    if (!claimed?.changes) continue;

    const handler = handlers.get(job.job_type);
    if (!handler) {
      await db.run(
        `UPDATE retry_queue SET status = 'dead', processing_at = NULL, last_error = ?, updated_at = datetime('now') WHERE id = ?`,
        [`handler ausente: ${job.job_type}`, job.id]
      );
      dead++;
      continue;
    }

    let payload: any;
    try {
      payload = JSON.parse(job.payload);
    } catch {
      await db.run(
        `UPDATE retry_queue SET status = 'dead', processing_at = NULL, last_error = 'payload JSON inválido', updated_at = datetime('now') WHERE id = ?`,
        [job.id]
      );
      dead++;
      continue;
    }

    const attempts = Number(job.attempts || 0) + 1;
    try {
      await handler(payload, job);
      await db.run(
        `UPDATE retry_queue SET status = 'done', attempts = ?, processing_at = NULL, updated_at = datetime('now'), last_error = NULL WHERE id = ?`,
        [attempts, job.id]
      );
      ok++;
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, 500);
      const maxA = Number(job.max_attempts || maxAttempts());
      if (attempts >= maxA) {
        await db.run(
          `UPDATE retry_queue SET status = 'dead', attempts = ?, processing_at = NULL, last_error = ?, updated_at = datetime('now') WHERE id = ?`,
          [attempts, err, job.id]
        );
        dead++;
        console.error(`[retry] dead job #${job.id} ${job.job_type}:`, err);
      } else {
        const next = nextBackoffIso(attempts);
        await db.run(
          `UPDATE retry_queue SET status = 'pending', attempts = ?, processing_at = NULL, last_error = ?, next_run_at = ?, updated_at = datetime('now') WHERE id = ?`,
          [attempts, err, next, job.id]
        );
        failed++;
        console.warn(`[retry] job #${job.id} tentativa ${attempts}/${maxA} → ${next}:`, err);
      }
    }
  }

  return { processed: (rows || []).length, ok, failed, dead };
}

export async function retryQueueStats(db: Database = getDb()) {
  await ensureRetryQueue(db);
  const rows = await db.all(
    `SELECT status, COUNT(*) as c FROM retry_queue GROUP BY status`
  );
  const by: Record<string, number> = {};
  for (const r of rows || []) by[r.status] = Number(r.c);
  const nowIso = new Date().toISOString();
  const pendingDue = await db.get(
    `SELECT COUNT(*) as c FROM retry_queue WHERE status = 'pending' AND next_run_at <= ?`,
    [nowIso]
  );
  return {
    by_status: by,
    pending_due: Number(pendingDue?.c || 0),
  };
}

let workerStarted = false;

export function startRetryWorker() {
  if (workerStarted) return;
  if (process.env.RETRY_WORKER === '0') {
    console.log('⏭️  Retry worker desligado (RETRY_WORKER=0)');
    return;
  }
  workerStarted = true;
  const interval = Math.max(10_000, Number(process.env.RETRY_WORKER_INTERVAL_MS || 60_000));

  const tick = () => {
    try {
      processRetryQueue(getDb(), 25).catch((e) =>
        console.warn('[retry worker]', e?.message || e)
      );
    } catch {
      /* db não pronto */
    }
  };

  tick();
  setInterval(tick, interval);
}
