/**
 * Adapter Postgres com API compatível com sqlite (get/run/all/exec).
 * Ativado quando DATABASE_URL começa com postgres.
 */
import pg from 'pg';
import type { Database } from 'sqlite';

const { Pool } = pg;

let pool: pg.Pool | null = null;

function convertPlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/**
 * Traduções SQLite → Postgres.
 * Ordem importa: funções date/datetime antes de tipos DATETIME.
 */
function adaptSql(sql: string): string {
  let s = sql;

  if (/INSERT\s+OR\s+IGNORE/i.test(s) && !/ON\s+CONFLICT/i.test(s)) {
    s = s.replace(/INSERT\s+OR\s+IGNORE/i, 'INSERT');
    if (!/ON\s+CONFLICT/i.test(s)) {
      s = s.replace(/;\s*$/, '') + ' ON CONFLICT DO NOTHING';
    }
  }

  // date('now', 'start of month') → início do mês
  s = s.replace(
    /date\s*\(\s*'now'\s*,\s*'start of month'\s*\)/gi,
    "date_trunc('month', CURRENT_TIMESTAMP)"
  );
  s = s.replace(
    /date\s*\(\s*"now"\s*,\s*"start of month"\s*\)/gi,
    "date_trunc('month', CURRENT_TIMESTAMP)"
  );

  // datetime('now', '-N days') / date('now', '-N days')
  s = s.replace(
    /(?:date|datetime)\s*\(\s*'now'\s*,\s*'-(\d+)\s*days?'\s*\)/gi,
    "(NOW() - INTERVAL '$1 days')"
  );
  s = s.replace(
    /(?:date|datetime)\s*\(\s*'now'\s*,\s*\"-(\d+)\s*days?\"\s*\)/gi,
    "(NOW() - INTERVAL '$1 days')"
  );

  // datetime('now', '-' || ? || ' days') — rotas podem preferir SQL nativo
  // datetime('now') / date('now')
  s = s.replace(/datetime\s*\(\s*'now'\s*\)/gi, 'NOW()');
  s = s.replace(/datetime\s*\(\s*\"now\"\s*\)/gi, 'NOW()');
  s = s.replace(/date\s*\(\s*'now'\s*\)/gi, 'CURRENT_DATE');
  s = s.replace(/date\s*\(\s*\"now\"\s*\)/gi, 'CURRENT_DATE');

  // strftime('%Y-%m', coluna) → to_char(coluna, 'YYYY-MM')
  s = s.replace(
    /strftime\s*\(\s*['\"]%Y-%m['\"]\s*,\s*([a-zA-Z_][\w.]*)\s*\)/gi,
    "to_char($1::timestamptz, 'YYYY-MM')"
  );

  // O relatório multiunidades pede slug por compatibilidade SQLite, mas o schema
  // PostgreSQL atual possui apenas id/nome/empresa_id/ativo. O PDF não usa slug.
  s = s.replace(
    /SELECT\s+id\s*,\s*nome\s*,\s*slug\s+FROM\s+unidades/gi,
    'SELECT id, nome FROM unidades'
  );

  // datetime(coluna) → cast seguro (1 arg)
  s = s.replace(/datetime\s*\(\s*([a-zA-Z_][\w.]*)\s*\)/gi, '($1::timestamptz)');

  s = s.replace(/CURRENT_TIMESTAMP/gi, 'NOW()');
  s = s.replace(/IFNULL\s*\(/gi, 'COALESCE(');

  // Tipos SQLite → Postgres
  s = s.replace(/\bDATETIME\b/gi, 'TIMESTAMPTZ');
  s = s.replace(/\bREAL\b/gi, 'DOUBLE PRECISION');
  s = s.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');
  s = s.replace(/AUTOINCREMENT/gi, '');

  return s;
}

async function handlePragma(client: pg.PoolClient, sql: string): Promise<any[]> {
  const m = sql.match(/PRAGMA\s+table_info\s*\(\s*['\"]?(\w+)['\"]?\s*\)/i);
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

export type PgDatabase = {
  exec: (sql: string) => Promise<void>;
  run: (sql: string, params?: any[]) => Promise<{ changes: number; lastID?: number }>;
  get: <T = any>(sql: string, params?: any[]) => Promise<T | undefined>;
  all: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
  close: () => Promise<void>;
};

export async function initPgDatabase(databaseUrl: string): Promise<PgDatabase> {
  pool = new Pool({
    connectionString: databaseUrl,
    ssl:
      process.env.PGSSL === '0'
        ? false
        : databaseUrl.includes('localhost')
          ? false
          : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX || 10),
  });

  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }

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

export function isPostgresUrl(url?: string | null): boolean {
  if (!url) return false;
  return /^postgres(ql)?:\/\//i.test(url.trim());
}

export function asSqliteDb(db: PgDatabase): Database {
  return db as unknown as Database;
}
