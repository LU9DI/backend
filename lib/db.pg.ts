/**
 * Adapter Postgres (Supabase / Render / local).
 * Supabase: use Connection string "Transaction" (pooler :6543) em free tier.
 */
import pg from 'pg';
import type { Database } from 'sqlite';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let connectedUrlHost = '';

function convertPlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function adaptSql(sql: string): string {
  let s = sql;

  if (/INSERT\s+OR\s+IGNORE/i.test(s) && !/ON\s+CONFLICT/i.test(s)) {
    s = s.replace(/INSERT\s+OR\s+IGNORE/i, 'INSERT');
    if (!/ON\s+CONFLICT/i.test(s)) {
      s = s.replace(/;\s*$/, '') + ' ON CONFLICT DO NOTHING';
    }
  }

  s = s.replace(
    /date\s*\(\s*'now'\s*,\s*'start of month'\s*\)/gi,
    "date_trunc('month', NOW())"
  );
  s = s.replace(
    /date\s*\(\s*"now"\s*,\s*"start of month"\s*\)/gi,
    "date_trunc('month', NOW())"
  );
  s = s.replace(/date\s*\(\s*'now'\s*\)/gi, 'CURRENT_DATE');
  s = s.replace(/date\s*\(\s*"now"\s*\)/gi, 'CURRENT_DATE');
  s = s.replace(/datetime\s*\(\s*'now'\s*\)/gi, 'NOW()');
  s = s.replace(/datetime\s*\(\s*"now"\s*\)/gi, 'NOW()');
  s = s.replace(/CURRENT_TIMESTAMP/gi, 'NOW()');
  s = s.replace(/IFNULL\s*\(/gi, 'COALESCE(');
  s = s.replace(/\bDATETIME\b/gi, 'TIMESTAMPTZ');
  s = s.replace(/\bREAL\b/gi, 'DOUBLE PRECISION');
  s = s.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');
  s = s.replace(/AUTOINCREMENT/gi, '');

  return s;
}

async function handlePragma(client: pg.PoolClient, sql: string): Promise<any[]> {
  const m = sql.match(/PRAGMA\s+table_info\s*\(\s*['"]?(\w+)['"]?\s*\)/i);
  if (!m) return [];
  const table = m[1];
  const r = await client.query(
    `SELECT column_name as name, data_type as type,
            CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END as notnull,
            column_default as dflt_value,
            CASE WHEN column_name IN (
              SELECT kcu.column_name FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
               AND tc.table_schema = kcu.table_schema
              WHERE tc.table_name = $1 AND tc.table_schema = 'public'
                AND tc.constraint_type = 'PRIMARY KEY'
            ) THEN 1 ELSE 0 END as pk
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  return r.rows;
}

function resolveDatabaseUrl(explicit?: string): string {
  const url = (
    explicit ||
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.SUPABASE_DATABASE_URL ||
    ''
  ).trim();
  if (!url) throw new Error('DATABASE_URL / SUPABASE_DB_URL ausente.');
  return url;
}

function isSupabaseUrl(url: string): boolean {
  return /supabase\.(co|com)/i.test(url) || /pooler\.supabase/i.test(url);
}

/** Detecta pooler Supabase (porta 6543 ou host pooler). */
function isPoolerUrl(url: string): boolean {
  return /:6543\b/.test(url) || /pooler\.supabase/i.test(url);
}

export type PgDatabase = {
  exec: (sql: string) => Promise<void>;
  run: (sql: string, params?: any[]) => Promise<{ changes: number; lastID?: number }>;
  get: <T = any>(sql: string, params?: any[]) => Promise<T | undefined>;
  all: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
  close: () => Promise<void>;
};

export async function initPgDatabase(databaseUrl?: string): Promise<PgDatabase> {
  const url = resolveDatabaseUrl(databaseUrl);
  connectedUrlHost = (() => {
    try {
      return new URL(url.replace(/^postgres(ql)?:/i, 'https:')).host;
    } catch {
      return 'postgres';
    }
  })();

  const supabase = isSupabaseUrl(url);
  const pooler = isPoolerUrl(url);
  // Free tier Supabase: poucas conexões; pooler transaction mode → pool pequeno
  const defaultMax = supabase ? (pooler ? 4 : 8) : 10;
  const max = Math.max(1, Number(process.env.PG_POOL_MAX || defaultMax));

  pool = new Pool({
    connectionString: url,
    ssl:
      process.env.PGSSL === '0'
        ? false
        : /localhost|127\.0\.0\.1/.test(url)
          ? false
          : { rejectUnauthorized: false },
    max,
    idleTimeoutMillis: Number(process.env.PG_IDLE_MS || 20_000),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 12_000),
    allowExitOnIdle: true,
  });

  const client = await pool.connect();
  try {
    await client.query('SELECT 1 AS ok');
  } finally {
    client.release();
  }

  console.log(
    `🐘 Postgres ok host=${connectedUrlHost} supabase=${supabase} pooler=${pooler} max=${max}`
  );

  const db: PgDatabase = {
    async exec(sql: string) {
      const adapted = adaptSql(sql);
      const statements = adapted
        .split(';')
        .map((x) => x.trim())
        .filter(Boolean);
      const c = await pool!.connect();
      try {
        for (const st of statements) {
          if (/^PRAGMA/i.test(st)) continue;
          try {
            await c.query(st);
          } catch (e: any) {
            const msg = String(e?.message || e);
            if (/already exists/i.test(msg) || e?.code === '42P07' || e?.code === '42701') {
              continue;
            }
            console.error('pg.exec falhou:', msg);
            console.error('SQL:', st.slice(0, 500));
            throw e;
          }
        }
      } finally {
        c.release();
      }
    },

    async run(sql: string, params: any[] = []) {
      const c = await pool!.connect();
      try {
        if (/^PRAGMA/i.test(sql.trim())) return { changes: 0 };
        const adapted = adaptSql(sql);
        const q = convertPlaceholders(adapted);
        const r = await c.query(q, params);
        return { changes: r.rowCount || 0, lastID: undefined };
      } finally {
        c.release();
      }
    },

    async get<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
      const c = await pool!.connect();
      try {
        if (/PRAGMA\s+table_info/i.test(sql)) {
          const rows = await handlePragma(c, sql);
          return rows[0] as T;
        }
        const adapted = adaptSql(sql);
        const q = convertPlaceholders(adapted);
        const r = await c.query(q, params);
        return r.rows[0] as T | undefined;
      } finally {
        c.release();
      }
    },

    async all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
      const c = await pool!.connect();
      try {
        if (/PRAGMA\s+table_info/i.test(sql)) {
          return (await handlePragma(c, sql)) as T[];
        }
        const adapted = adaptSql(sql);
        const q = convertPlaceholders(adapted);
        const r = await c.query(q, params);
        return r.rows as T[];
      } finally {
        c.release();
      }
    },

    async close() {
      await pool?.end();
      pool = null;
    },
  };

  return db;
}

export function postgresHostLabel(): string {
  return connectedUrlHost || 'unknown';
}

export function isPostgresUrl(url?: string | null): boolean {
  if (!url) return false;
  return /^postgres(ql)?:\/\//i.test(url.trim());
}

export function asSqliteDb(db: PgDatabase): Database {
  return db as unknown as Database;
}
