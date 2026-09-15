/**
 * Adapter Postgres — API compatível sqlite (get/run/all/exec).
 * CRÍTICO: nunca transformar datetime(?,?) em timestamptz(?,?).
 * Também reescreve rowid / substr / strftime / createdAt (legado SQLite).
 */
import pg from 'pg';
import type { Database } from 'sqlite';

const { Pool } = pg;
let pool: pg.Pool | null = null;

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
    "date_trunc('month', CURRENT_TIMESTAMP)"
  );
  s = s.replace(
    /(?:date|datetime)\s*\(\s*'now'\s*,\s*'-(\d+)\s*days?'\s*\)/gi,
    "(NOW() - INTERVAL '$1 days')"
  );
  s = s.replace(/datetime\s*\(\s*'now'\s*\)/gi, 'NOW()');
  s = s.replace(/date\s*\(\s*'now'\s*\)/gi, 'CURRENT_DATE');
  s = s.replace(/\bdatetime\s*\([^)]*,[^)]*\)/gi, 'NOW()');
  s = s.replace(/\bdate\s*\([^)]*,[^)]*\)/gi, 'CURRENT_DATE');
  s = s.replace(/\btimestamptz\s*\([^)]*,[^)]*\)/gi, 'NOW()');

  s = s.replace(
    /substr\s*\(\s*([\w."]+)\s*,\s*1\s*,\s*7\s*\)/gi,
    "to_char(($1)::timestamptz, 'YYYY-MM')"
  );
  s = s.replace(
    /substr\s*\(\s*([\w."]+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/gi,
    'substring(($1)::text from $2 for $3)'
  );
  s = s.replace(
    /strftime\s*\(\s*['"]%Y-%m['"]\s*,\s*([\w."]+)\s*\)/gi,
    "to_char(($1)::timestamptz, 'YYYY-MM')"
  );

  s = s.replace(/last_insert_rowid\s*\(\s*\)/gi, 'NULL');
  s = s.replace(/\browid\b/gi, 'ctid');

  // SQLite aceita createdAt como identificador camelCase. No PostgreSQL,
  // identificadores não citados são convertidos para minúsculas (createdat).
  // Portanto, nunca gere "createdAt": isso procura uma coluna diferente.
  s = s.replace(/(?<!["\w])createdAt(?!["\w])/g, 'createdat');

  s = s.replace(/IFNULL\s*\(/gi, 'COALESCE(');
  s = s.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');
  s = s.replace(/\bAUTOINCREMENT\b/gi, '');
  s = s.replace(/\bDATETIME\b(?!\s*\()/gi, 'TIMESTAMPTZ');
  s = s.replace(/\bREAL\b/gi, 'DOUBLE PRECISION');

  return s;
}

/**
 * Mantém a API legada da aplicação: o PostgreSQL retorna `createdat`
 * para a coluna criada sem aspas, mas o restante do código usa `createdAt`.
 */
function normalizeRow<T = any>(row: any): T {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row as T;
  if (Object.prototype.hasOwnProperty.call(row, 'createdat')) {
    const normalized = { ...row };
    if (!Object.prototype.hasOwnProperty.call(normalized, 'createdAt')) {
      normalized.createdAt = normalized.createdat;
    }
    delete normalized.createdat;
    return normalized as T;
  }
  return row as T;
}

function normalizeRows<T = any>(rows: any[]): T[] {
  return rows.map((row) => normalizeRow<T>(row));
}

async function handlePragma(client: pg.PoolClient, sql: string): Promise<any[]> {
  const m = sql.match(/PRAGMA\s+table_info\s*\(\s*['"]?(\w+)['"]?\s*\)/i);
  if (!m) return [];
  const table = m[1].toLowerCase();
  const r = await client.query(
    `SELECT column_name as name, data_type as type,
            CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END as notnull,
            column_default as dflt_value,
            0 as pk
     FROM information_schema.columns
     WHERE table_schema = 'public' AND lower(table_name) = $1
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
        : /localhost|127\.0\.0\.1/.test(databaseUrl)
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
      const statements = adapted.split(';').map((x) => x.trim()).filter(Boolean);
      const c = await pool!.connect();
      try {
        for (const st of statements) {
          if (/^PRAGMA/i.test(st)) continue;
          try {
            await c.query(st);
          } catch (e: any) {
            const msg = String(e?.message || e);
            if (/already exists/i.test(msg) || e?.code === '42P07' || e?.code === '42701') continue;
            console.error('pg.exec falhou:', msg);
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
        const q = convertPlaceholders(adaptSql(sql));
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
          return normalizeRow<T>(rows[0]);
        }
        const q = convertPlaceholders(adaptSql(sql));
        const r = await c.query(q, params);
        return normalizeRow<T>(r.rows[0]);
      } finally {
        c.release();
      }
    },
    async all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
      const c = await pool!.connect();
      try {
        if (/PRAGMA\s+table_info/i.test(sql)) {
          return normalizeRows<T>(await handlePragma(c, sql));
        }
        const q = convertPlaceholders(adaptSql(sql));
        const r = await c.query(q, params);
        return normalizeRows<T>(r.rows);
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
