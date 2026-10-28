/**
 * Adapter Postgres — API compatível sqlite (get/run/all/exec).
 * CRÍTICO: nunca transformar datetime(?,?) em timestamptz(?,?).
 * Também reescreve rowid / substr / createdAt (legado SQLite).
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

  // Funções SQLite de data ANTES de mexer na palavra DATETIME como tipo
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

  // Qualquer datetime(x,y) residual → NOW() (NUNCA timestamptz)
  s = s.replace(/\bdatetime\s*\([^)]*,[^)]*\)/gi, 'NOW()');
  s = s.replace(/\bdate\s*\([^)]*,[^)]*\)/gi, 'CURRENT_DATE');
  s = s.replace(/\btimestamptz\s*\([^)]*,[^)]*\)/gi, 'NOW()');

  // substr(col, 1, 7) em timestamps (SQLite YYYY-MM) → to_char
  s = s.replace(
    /substr\s*\(\s*([\w."]+)\s*,\s*1\s*,\s*7\s*\)/gi,
    "to_char(($1)::timestamptz, 'YYYY-MM')"
  );
  // substr genérico em coluna de data ainda comum
  s = s.replace(
    /substr\s*\(\s*([\w."]+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/gi,
    'substring(($1)::text from $2 for $3)'
  );

  // rowid / last_insert_rowid (SQLite) — Postgres não tem
  s = s.replace(/last_insert_rowid\s*\(\s*\)/gi, 'NULL');
  s = s.replace(/\browid\b/gi, 'ctid');

  // createdAt sem aspas vira createdat no PG; forçar identificador citado
  s = s.replace(/(?<!["\w])createdAt(?!["\w])/g, '"createdAt"');

  s = s.replace(/IFNULL\s*\(/gi, 'COALESCE(');
  s = s.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');
  s = s.replace(/\bAUTOINCREMENT\b/gi, '');

  // Tipo de coluna: DATETIME só se NÃO for função (sem parêntese depois)
  s = s.replace(/\bDATETIME\b(?!\s*\()/gi, 'TIMESTAMPTZ');
  s = s.replace(/\bREAL\b/gi, 'DOUBLE PRECISION');

  return s;
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
  transaction: <T>(fn: (tx: PgDatabase) => Promise<T>) => Promise<T>;
};

export function getPgSslConfig(
  databaseUrl: string,
  pgssl: string | undefined = process.env.PGSSL,
  caPem: string | undefined = process.env.PGSSL_CA,
): false | { rejectUnauthorized: true; ca?: string } {
  let hostname = "";
  try {
    const parsedHostname = new URL(databaseUrl).hostname.toLowerCase();
    hostname = parsedHostname.startsWith("[") && parsedHostname.endsWith("]")
      ? parsedHostname.slice(1, -1)
      : parsedHostname;
  } catch {
    // Leave malformed URL handling to the PostgreSQL driver with TLS validation enabled.
  }
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (pgssl === "0" && !isLocal) {
    throw new Error("PGSSL=0 is permitted only for localhost PostgreSQL connections");
  }
  if (isLocal) return false;

  // Keep certificate validation enabled. Some managed PostgreSQL providers
  // require their official CA certificate to be supplied explicitly.
  // Render env vars may store PEM newlines as literal "\\n".
  const ca = caPem?.trim().replace(/\\n/g, "\n");
  return {
    rejectUnauthorized: true,
    ...(ca ? { ca } : {}),
  };
}

export async function initPgDatabase(databaseUrl: string): Promise<PgDatabase> {
  const connectionTimeoutMs = Math.max(
    3000,
    Number(process.env.PG_CONNECT_TIMEOUT_MS || 10_000),
  );
  const maxConnectAttempts = Math.max(
    1,
    Number(process.env.PG_CONNECT_ATTEMPTS || 3),
  );

  pool = new Pool({
    connectionString: databaseUrl,
    ssl: getPgSslConfig(databaseUrl),
    max: Number(process.env.PG_POOL_MAX || 10),
    connectionTimeoutMillis: connectionTimeoutMs,
    idleTimeoutMillis: Math.max(10_000, Number(process.env.PG_IDLE_TIMEOUT_MS || 30_000)),
    keepAlive: true,
  });

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxConnectAttempts; attempt += 1) {
    try {
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      console.warn(
        `🐘 Postgres conexão tentativa ${attempt}/${maxConnectAttempts} falhou:`,
        String((error as any)?.message || error),
      );
      if (attempt < maxConnectAttempts) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(5000, attempt * 1500)));
      }
    }
  }

  if (lastError) {
    await pool.end().catch(() => undefined);
    pool = null;
    throw lastError;
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
            if (
              /already exists/i.test(msg) ||
              e?.code === '42P07' ||
              e?.code === '42701' ||
              // Corrida de DDL entre instâncias: dois CREATE TABLE/INDEX
              // IF NOT EXISTS simultâneos podem colidir nos índices únicos do
              // catálogo (pg_type, pg_class, pg_attribute...). O objeto foi
              // criado pela outra instância; seguir é idempotente.
              (e?.code === '23505' && /unique constraint "pg_(type|class|attribute|index|constraint|proc)/i.test(msg))
            ) {
              continue;
            }
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
        const returnedId = (r.rows?.[0] && (r.rows[0].id ?? r.rows[0].ID)) as number | undefined;
        return { changes: r.rowCount || 0, lastID: returnedId };
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
        const q = convertPlaceholders(adaptSql(sql));
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
        const q = convertPlaceholders(adaptSql(sql));
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

    async transaction<T>(fn: (tx: PgDatabase) => Promise<T>) {
      const c = await pool!.connect();
      const tx: PgDatabase = {
        async exec(sql: string) {
          const adapted = adaptSql(sql);
          for (const st of adapted.split(';').map((x) => x.trim()).filter(Boolean)) {
            if (/^PRAGMA/i.test(st)) continue;
            await c.query(st);
          }
        },
        async run(sql: string, params: any[] = []) {
          if (/^PRAGMA/i.test(sql.trim())) return { changes: 0 };
          const q = convertPlaceholders(adaptSql(sql));
          const r = await c.query(q, params);
          const returnedId = (r.rows?.[0] && (r.rows[0].id ?? r.rows[0].ID)) as number | undefined;
          return { changes: r.rowCount || 0, lastID: returnedId };
        },
        async get<T2 = any>(sql: string, params: any[] = []) {
          if (/PRAGMA\s+table_info/i.test(sql)) return (await handlePragma(c, sql))[0] as T2;
          const r = await c.query(convertPlaceholders(adaptSql(sql)), params);
          return r.rows[0] as T2 | undefined;
        },
        async all<T2 = any>(sql: string, params: any[] = []) {
          if (/PRAGMA\s+table_info/i.test(sql)) return (await handlePragma(c, sql)) as T2[];
          const r = await c.query(convertPlaceholders(adaptSql(sql)), params);
          return r.rows as T2[];
        },
        async close() { /* transaction client owns its connection */ },
        async transaction<T2>(nested: (tx: PgDatabase) => Promise<T2>) {
          return nested(tx);
        },
      };
      try {
        await c.query('BEGIN');
        const result = await fn(tx);
        await c.query('COMMIT');
        return result;
      } catch (error) {
        try { await c.query('ROLLBACK'); } catch {}
        throw error;
      } finally {
        c.release();
      }
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
