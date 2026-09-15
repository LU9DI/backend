/**
 * Fila de retry persistente com backoff (SQLite + Postgres).
 */
import type { Database } from 'sqlite';
import { getDb } from './db.js';

export type RetryJobType =
  | 'paypal_webhook'
  | 'email'
  | 'capture_paypal'
  | 'mp_webhook'
  | 'generic'
  | string;

function nowSql(): string {
  return new Date().toISOString();
}

export async function ensureRetryQueue(db: Database = getDb()) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS retry_queue (
      id SERIAL PRIMARY KEY,
      job_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 8,
      next_run_at TIMESTAMPTZ NOT NULL,
      last_error TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      dedupe_key TEXT
    )
  `);
  // SQLite fallback se SERIAL falhar — já existe tabela
  try {
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_retry_pending ON retry_queue(status, next_run_at)`
    );
  } catch {
    /* ok */
  }
  try {
    await db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_retry_dedupe ON retry_queue(dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'pending'`
    );
  } catch {
    /* partial unique pode falhar em alguns engines */
  }
}

function maxAttempts(): number {
  return Math.max(1, Number(process.env.RETRY_MAX_ATTEMPTS || 8));
}

function baseMs(): number {
  return Math.max(1000, Number(process.env.RETRY_BASE_MS || 30_000));
}

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

  const r = await db.run(
    `INSERT INTO retry_queue (job_type, payload, attempts, max_attempts, next_run_at, status, dedupe_key, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?, 'pending', ?, ?, ?)`,
    [
      opts.jobType,
      JSON.stringify(opts.payload),
      opts.maxAttempts ?? maxAttempts(),
      next,
      opts.dedupeKey || null,
      nowSql(),
      nowSql(),
    ]
  );
  return Number(r.lastID || 0);
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
    const handler = handlers.get(job.job_type);
    if (!handler) {
      await db.run(
        `UPDATE retry_queue SET status = 'dead', last_error = ?, updated_at = ? WHERE id = ?`,
        [`handler ausente: ${job.job_type}`, nowSql(), job.id]
      );
      dead++;
      continue;
    }

    let payload: any;
    try {
      payload = JSON.parse(job.payload);
    } catch {
      await db.run(
        `UPDATE retry_queue SET status = 'dead', last_error = 'payload JSON inválido', updated_at = ? WHERE id = ?`,
        [nowSql(), job.id]
      );
      dead++;
      continue;
    }

    const attempts = Number(job.attempts || 0) + 1;
    try {
      await handler(payload, job);
      await db.run(
        `UPDATE retry_queue SET status = 'done', attempts = ?, updated_at = ?, last_error = NULL WHERE id = ?`,
        [attempts, nowSql(), job.id]
      );
      ok++;
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, 500);
      const maxA = Number(job.max_attempts || maxAttempts());
      if (attempts >= maxA) {
        await db.run(
          `UPDATE retry_queue SET status = 'dead', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
          [attempts, err, nowSql(), job.id]
        );
        dead++;
        console.error(`[retry] dead job #${job.id} ${job.job_type}:`, err);
      } else {
        const next = nextBackoffIso(attempts);
        await db.run(
          `UPDATE retry_queue SET status = 'pending', attempts = ?, last_error = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
          [attempts, err, next, nowSql(), job.id]
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
  const rows = await db.all(`SELECT status, COUNT(*) as c FROM retry_queue GROUP BY status`);
  const by: Record<string, number> = {};
  for (const r of rows || []) by[r.status] = Number(r.c);
  const agora = new Date().toISOString();
  const pendingDue = await db.get(
    `SELECT COUNT(*) as c FROM retry_queue WHERE status = 'pending' AND next_run_at <= ?`,
    [agora]
  );
  return { by_status: by, pending_due: Number(pendingDue?.c || 0) };
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
      processRetryQueue(getDb(), 25).catch((e) => console.warn('[retry worker]', e?.message || e));
    } catch {
      /* db não pronto */
    }
  };

  const t = setInterval(tick, interval);
  if (typeof t === 'object' && t && 'unref' in t) (t as NodeJS.Timeout).unref();
  setTimeout(tick, 5000);
  console.log(`🔄 Retry worker a cada ${Math.round(interval / 1000)}s`);
}
