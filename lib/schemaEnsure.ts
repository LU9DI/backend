/**
 * Garante colunas/tabelas extras em schemas legados.
 *
 * Dev  → SQLite  (PRAGMA table_info)
 * Prod → Postgres (information_schema.columns)
 *
 * Regras:
 * - Nunca interpolar nomes de tabela/coluna fora da whitelist.
 * - Idempotente: pode rodar a cada boot.
 * - ADD COLUMN só se a coluna realmente não existir.
 */
import type { Database } from 'sqlite';
import { isPostgresUrl } from './db.pg.js';

/** Tabelas que este módulo pode alterar. */
const ALLOWED_TABLES = new Set(['empresas', 'usuarios', 'relatorio_destinatarios', 'relatorio_cache']);

/** Colunas permitidas por tabela (evita SQL injection via nome). */
const ALLOWED_COLUMNS: Record<string, Set<string>> = {
  empresas: new Set([
    'slug',
    'google_review_url',
    'whatsapp_suporte',
    'voice_style',
    'empresa_pai_id',
    'payment_gateway',
    'mp_preapproval_id',
    'billing_cycle',
    'cancel_at_period_end',
    'stripe_customer_id',
    'stripe_subscription_id',
    'report_next_due_at',
    'report_last_sent_at',
    'report_claim_token',
    'report_claimed_at',
  ]),
  usuarios: new Set(['email']),
  relatorio_destinatarios: new Set([
    'id',
    'empresa_id',
    'canal',
    'destino',
    'nome',
    'ativo',
    'criado_em',
  ]),
  relatorio_cache: new Set([
    'id',
    'empresa_id',
    'periodo_inicio',
    'periodo_fim',
    'nivel',
    'dados_hash',
    'texto',
    'criado_em',
  ]),
};

function isPostgres(): boolean {
  return isPostgresUrl(process.env.DATABASE_URL);
}

function assertSafeIdent(table: string, column?: string) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`[schema] tabela não permitida: ${table}`);
  }
  if (column != null && !ALLOWED_COLUMNS[table]?.has(column)) {
    throw new Error(`[schema] coluna não permitida: ${table}.${column}`);
  }
}

/**
 * Lista nomes de colunas existentes.
 * Postgres: information_schema (parametrizado).
 * SQLite: PRAGMA table_info.
 */
async function columnNames(db: Database, table: string): Promise<Set<string>> {
  assertSafeIdent(table);
  try {
    if (isPostgres()) {
      const rows = await db.all(
        `SELECT column_name AS name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ?
         ORDER BY ordinal_position`,
        [table]
      );
      return new Set((rows || []).map((r: any) => String(r.name || r.column_name || '')));
    }

    const rows = await db.all(`PRAGMA table_info(${table})`);
    return new Set((rows || []).map((r: any) => String(r.name)));
  } catch (e: any) {
    console.warn(`[schema] columnNames(${table}):`, e?.message || e);
    return new Set();
  }
}

/**
 * Tipos DDL adaptados ao motor.
 * - Postgres: TIMESTAMPTZ, INTEGER/BOOLEAN-friendly
 * - SQLite: TEXT para datas ISO (compatível com o restante do código)
 */
function ddlFor(column: string, prefer: 'text' | 'int' | 'timestamptz' = 'text'): string {
  const pg = isPostgres();
  if (prefer === 'int') return pg ? 'INTEGER DEFAULT 0' : 'INTEGER DEFAULT 0';
  if (prefer === 'timestamptz') return pg ? 'TIMESTAMPTZ' : 'TEXT';
  return 'TEXT';
}

async function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  prefer: 'text' | 'int' | 'timestamptz' = 'text'
) {
  assertSafeIdent(table, column);
  const cols = await columnNames(db, table);
  if (cols.has(column)) return;

  const typeSql = ddlFor(column, prefer);
  try {
    // Nomes já validados pela whitelist — seguro concatenar.
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql}`);
    console.log(`[schema] + ${table}.${column} (${isPostgres() ? 'pg' : 'sqlite'})`);
  } catch (e: any) {
    const msg = String(e?.message || e);
    // 42701 = duplicate_column (Postgres)
    if (/already exists|duplicate column|42701/i.test(msg)) return;
    console.warn(`[schema] ${table}.${column}:`, msg);
  }
}

async function ensureRelatorioDestinatarios(db: Database) {
  try {
    if (isPostgres()) {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS relatorio_destinatarios (
          id TEXT PRIMARY KEY,
          empresa_id TEXT NOT NULL,
          canal TEXT NOT NULL,
          destino TEXT NOT NULL,
          nome TEXT,
          ativo INTEGER NOT NULL DEFAULT 1,
          criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    } else {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS relatorio_destinatarios (
          id TEXT PRIMARY KEY,
          empresa_id TEXT NOT NULL,
          canal TEXT NOT NULL,
          destino TEXT NOT NULL,
          nome TEXT,
          ativo INTEGER NOT NULL DEFAULT 1,
          criado_em TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    }

    await db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_relatorio_dest_empresa_canal_destino
      ON relatorio_destinatarios(empresa_id, canal, destino)
    `);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_relatorio_dest_empresa
      ON relatorio_destinatarios(empresa_id, ativo)
    `);
  } catch (e: any) {
    console.warn('[schema] relatorio_destinatarios:', e?.message || e);
  }
}

/**
 * Cache de relatório textual (1 geração → N destinatários).
 * nivel no dados_hash / coluna evita servir cache de plano inferior após upgrade.
 */
async function ensureRelatorioCache(db: Database) {
  try {
    if (isPostgres()) {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS relatorio_cache (
          id TEXT PRIMARY KEY,
          empresa_id TEXT NOT NULL,
          periodo_inicio TEXT NOT NULL,
          periodo_fim TEXT NOT NULL,
          nivel TEXT NOT NULL,
          dados_hash TEXT NOT NULL,
          texto TEXT NOT NULL,
          criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    } else {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS relatorio_cache (
          id TEXT PRIMARY KEY,
          empresa_id TEXT NOT NULL,
          periodo_inicio TEXT NOT NULL,
          periodo_fim TEXT NOT NULL,
          nivel TEXT NOT NULL,
          dados_hash TEXT NOT NULL,
          texto TEXT NOT NULL,
          criado_em TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    }

    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_relatorio_cache_empresa
      ON relatorio_cache(empresa_id, periodo_inicio, periodo_fim)
    `);
    await db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_relatorio_cache_hash
      ON relatorio_cache(empresa_id, dados_hash)
    `);
  } catch (e: any) {
    console.warn('[schema] relatorio_cache:', e?.message || e);
  }
}

async function ensureIndexes(db: Database) {
  const indexes = [
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_cnpj ON empresas(cnpj)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_slug ON empresas(slug)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email)`,
    `CREATE INDEX IF NOT EXISTS idx_empresas_report_due ON empresas(report_next_due_at)`,
  ];
  for (const sql of indexes) {
    try {
      await db.exec(sql);
    } catch {
      /* índice já existe ou coluna ainda não — ok */
    }
  }
}

/** Colunas usadas por trial, painel, billing e relatório multicanal. */
export async function ensureRuntimeSchema(db: Database) {
  const engine = isPostgres() ? 'postgres' : 'sqlite';
  console.log(`[schema] ensureRuntimeSchema (${engine})`);

  // empresas — billing / gateway
  await addColumnIfMissing(db, 'empresas', 'slug', 'text');
  await addColumnIfMissing(db, 'empresas', 'google_review_url', 'text');
  await addColumnIfMissing(db, 'empresas', 'whatsapp_suporte', 'text');
  await addColumnIfMissing(db, 'empresas', 'voice_style', 'text');
  await addColumnIfMissing(db, 'empresas', 'empresa_pai_id', 'text');
  await addColumnIfMissing(db, 'empresas', 'payment_gateway', 'text');
  await addColumnIfMissing(db, 'empresas', 'mp_preapproval_id', 'text');
  await addColumnIfMissing(db, 'empresas', 'billing_cycle', 'text');
  await addColumnIfMissing(db, 'empresas', 'cancel_at_period_end', 'int');
  await addColumnIfMissing(db, 'empresas', 'stripe_customer_id', 'text');
  await addColumnIfMissing(db, 'empresas', 'stripe_subscription_id', 'text');

  // aniversário do relatório (ciclo mensal)
  await addColumnIfMissing(db, 'empresas', 'report_next_due_at', 'timestamptz');
  await addColumnIfMissing(db, 'empresas', 'report_last_sent_at', 'timestamptz');
  // claim atômico do job (concorrência)
  await addColumnIfMissing(db, 'empresas', 'report_claim_token', 'text');
  await addColumnIfMissing(db, 'empresas', 'report_claimed_at', 'timestamptz');

  await addColumnIfMissing(db, 'usuarios', 'email', 'text');

  await ensureRelatorioDestinatarios(db);
  await ensureRelatorioCache(db);
  await ensureIndexes(db);

  // Sanity: se Postgres, report_next_due_at deve aparecer no information_schema
  if (isPostgres()) {
    const cols = await columnNames(db, 'empresas');
    if (!cols.has('report_next_due_at')) {
      console.warn(
        '[schema] AVISO: report_next_due_at ausente em empresas após ensure — job de relatório pode falhar'
      );
    } else {
      console.log('[schema] empresas.report_next_due_at OK');
    }
  }
}
