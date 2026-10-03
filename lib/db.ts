/**
 * Banco: Postgres em produção (obrigatório).
 * SQLite só em desenvolvimento local.
 */
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import type { Database } from 'sqlite';
import { fileURLToPath } from 'url';
import { ensureAuthColumns } from '../passwordResetRoutes.js';
import { ensureMfaColumns } from '../mfa.js';
import { initPgDatabase, isPostgresUrl, asSqliteDb } from './db.pg.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProd = process.env.NODE_ENV === 'production';

let _db: Database | null = null;
let _engine: 'sqlite' | 'postgres' = 'sqlite';

export function getDb(): Database {
  if (!_db) throw new Error('Banco ainda não inicializado. Chame initDB() primeiro.');
  return _db;
}

export function dbEngine(): 'sqlite' | 'postgres' {
  return _engine;
}

export async function withDbTransaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
  const db: any = getDb();
  if (typeof db.transaction === 'function') {
    return db.transaction(async (tx: any) => fn(tx as Database));
  }
  await db.exec('BEGIN');
  try {
    const result = await fn(db as Database);
    await db.exec('COMMIT');
    return result;
  } catch (error) {
    try { await db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export async function closeDB(): Promise<void> {
  const db = _db as any;
  _db = null;
  if (db && typeof db.close === 'function') await db.close();
}

export async function pingDb(): Promise<{ ok: boolean; engine: string; error?: string }> {
  try {
    const db = getDb();
    await db.get('SELECT 1 AS ok');
    return { ok: true, engine: _engine };
  } catch (e: any) {
    return { ok: false, engine: _engine, error: String(e?.message || e) };
  }
}

async function initSqlite(): Promise<Database> {
  let sqlite3: any;
  let open: any;
  try {
    sqlite3 = (await import('sqlite3')).default;
    open = (await import('sqlite')).open;
  } catch {
    throw new Error(
      'SQLite não instalado. Use DATABASE_URL=postgresql://... ou npm i -D sqlite sqlite3'
    );
  }

  const dbPath =
    process.env.SQLITE_DB_PATH ||
    path.resolve(__dirname, '..', '..', 'data', 'database.sqlite');

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  _engine = 'sqlite';
  console.log(`💾 SQLite: ${dbPath}`);
  return db as Database;
}

async function initPostgresWithUrl(url: string): Promise<Database> {
  const pg = await initPgDatabase(url);
  _engine = 'postgres';
  console.log('🐘 Postgres conectado');
  return asSqliteDb(pg);
}

async function initPostgres(): Promise<Database> {
  return initPostgresWithUrl(process.env.DATABASE_URL!.trim());
}

export async function initDB(): Promise<Database> {
  const useSupabase = process.env.USE_SUPABASE_DB === '1';
  const supabasePassword = (process.env.SUPABASE_DB_PASSWORD || '').trim();
  const supabaseHost = (process.env.SUPABASE_DB_HOST || '').trim();
  const supabaseUser = (process.env.SUPABASE_DB_USER || '').trim();
  const supabaseName = (process.env.SUPABASE_DB_NAME || 'postgres').trim();
  const supabasePort = Number(process.env.SUPABASE_DB_PORT || 5432);

  if (useSupabase) {
    if (!supabasePassword || !supabaseHost || !supabaseUser) {
      throw new Error('USE_SUPABASE_DB=1 exige SUPABASE_DB_PASSWORD, SUPABASE_DB_HOST e SUPABASE_DB_USER.');
    }
    const auth = encodeURIComponent(supabaseUser) + ':' + encodeURIComponent(supabasePassword);
    const url = 'postgresql://' + auth + '@' + supabaseHost + ':' + supabasePort + '/' + encodeURIComponent(supabaseName);
    _db = await initPostgresWithUrl(url);
  } else {
    const url = process.env.DATABASE_URL?.trim();
    if (isPostgresUrl(url)) {
      _db = await initPostgres();
    } else if (isProd) {
      throw new Error(
        'DATABASE_URL com uma URL PostgreSQL válida é obrigatória em produção. SQLite não é permitido.'
      );
    } else {
      _db = await initSqlite();
    }
  }


  await _db.exec(`
    CREATE TABLE IF NOT EXISTS empresas (
      id TEXT PRIMARY KEY,
      cnpj TEXT UNIQUE NOT NULL,
      nome_empresa TEXT NOT NULL,
      slug TEXT UNIQUE,
      status TEXT DEFAULT 'trial',
      plan TEXT DEFAULT 'trial',
      criado_em TIMESTAMPTZ NOT NULL,
      expira_em TIMESTAMPTZ NOT NULL,
      google_review_url TEXT,
      voice_style TEXT,
      empresa_pai_id TEXT,
      whatsapp_suporte TEXT
    )
  `);
  await _db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id TEXT PRIMARY KEY,
      cnpj TEXT NOT NULL,
      nome_funcionario TEXT NOT NULL,
      empresa_id TEXT NOT NULL,
      senha_hash TEXT NOT NULL
    )
  `);
  await _db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT,
      name TEXT,
      rating INTEGER,
      comment TEXT,
      ai_reply TEXT,
      ai_tags TEXT,
      createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Migração compatível: bancos Postgres antigos podem ter criado reviews.created_at
  // antes do schema atual usar o identificador legado "createdAt". O painel e alguns
  // fluxos dependem desse campo; mantemos ambos durante a transição.
  try {
    await _db.exec('ALTER TABLE reviews ADD COLUMN "createdAt" TIMESTAMPTZ');
  } catch {
    /* coluna já existe */
  }
  try {
    await _db.run(
      'UPDATE reviews SET "createdAt" = created_at WHERE "createdAt" IS NULL AND created_at IS NOT NULL'
    );
  } catch {
    /* banco já usa somente createdAt */
  }
  try {
    await _db.run(
      'UPDATE reviews SET "createdAt" = createdat WHERE "createdAt" IS NULL AND createdat IS NOT NULL'
    );
  } catch {
    /* variante sem aspas não existe */
  }
  try {
    await _db.exec('ALTER TABLE reviews ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP');
  } catch {
    /* SQLite não suporta ALTER COLUMN; o schema local já cria createdAt com default */
  }

  await _db.exec(`
    CREATE TABLE IF NOT EXISTS trial_registrations (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      ip_hash TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await _db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT,
      tipo TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      criado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await _db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      plan TEXT NOT NULL,
      month TEXT NOT NULL,
      tags INTEGER DEFAULT 0,
      respostas INTEGER DEFAULT 0,
      PRIMARY KEY (plan, month)
    )
  `);

  try {
    await _db.exec(`CREATE INDEX IF NOT EXISTS idx_reviews_empresa ON reviews(empresa_id)`);
    await _db.exec(`CREATE INDEX IF NOT EXISTS idx_empresas_cnpj ON empresas(cnpj)`);
    await _db.exec(`CREATE INDEX IF NOT EXISTS idx_empresas_slug ON empresas(slug)`);
  } catch {
    /* ok */
  }

  await ensureAuthColumns(_db);
  await ensureMfaColumns(_db);

  const adminMail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPass = process.env.ADMIN_PASSWORD || '';
  if (adminMail && adminPass.length >= 12) {
    const adminExiste = await _db.get('SELECT id FROM usuarios WHERE email = ?', [adminMail]);
    if (!adminExiste) {
      const hash = await bcrypt.hash(adminPass, 12);
      try {
        await _db.run(
          'INSERT INTO usuarios (id, cnpj, nome_funcionario, empresa_id, senha_hash, email) VALUES (?, ?, ?, ?, ?, ?)',
          [crypto.randomUUID(), '00000000000000', 'Admin', 'admin', hash, adminMail]
        );
        console.log(`🔑 Admin criado: ${adminMail}`);
      } catch (e: any) {
        console.warn('Admin seed:', e?.message || e);
      }
    }
  } else if (isProd && adminMail && adminPass.length > 0 && adminPass.length < 12) {
    console.warn('⚠️  ADMIN_PASSWORD curta (<12) — admin não será seedado automaticamente.');
  }

  return _db;
}

export async function findEmpresa(ref: string) {
  const db = getDb();
  if (!ref) return null;
  const porId = await db.get('SELECT * FROM empresas WHERE id = ?', [ref]);
  if (porId) return porId;
  return db.get('SELECT * FROM empresas WHERE slug = ?', [ref]);
}

export function slugify(texto: string): string {
  return (
    texto
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'empresa'
  );
}

export async function slugUnico(base: string): Promise<string> {
  const db = getDb();
  let slug = base;
  let n = 0;
  while (true) {
    const existe = await db.get('SELECT id FROM empresas WHERE slug = ?', [slug]);
    if (!existe) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}
