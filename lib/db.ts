/**
 * Banco: Postgres (Supabase recomendado) em produção.
 */
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import type { Database } from 'sqlite';
import { fileURLToPath } from 'url';
import { ensureAuthColumns } from '../passwordResetRoutes.js';
import { ensureMfaColumns } from '../mfa.js';
import {
  initPgDatabase,
  isPostgresUrl,
  asSqliteDb,
  postgresHostLabel,
} from './db.pg.js';

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

export function dbHostLabel(): string {
  return _engine === 'postgres' ? postgresHostLabel() : 'sqlite';
}

/**
 * Verifica se o banco está respondendo.
 * Retorna objeto indicando ok, engine usado e eventual erro.
 */
export async function pingDb(): Promise<{ ok: boolean; engine: string; error?: string }> {
  if (!_db) {
    return { ok: false, engine: _engine || 'unknown', error: 'db not initialized' };
  }
  try {
    await _db.get('SELECT 1 as ok');
    return { ok: true, engine: _engine };
  } catch (e: any) {
    return {
      ok: false,
      engine: _engine,
      error: String(e?.message || e).slice(0, 200),
    };
  }
}

function resolvePgUrl(): string | undefined {
  const u = (
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.SUPABASE_DATABASE_URL ||
    ''
  ).trim();
  return u || undefined;
}

>>>>>>> 0cdf90b54e30a5681dd483a1b9a1aaee7b3e2f3f
async function initSqlite(): Promise<Database> {
  let sqlite3: any;
  let open: any;
  try {
    sqlite3 = (await import('sqlite3')).default;
    open = (await import('sqlite')).open;
  } catch {
    throw new Error(
      'SQLite não instalado. Em produção use DATABASE_URL (Supabase). Em dev: npm i -D sqlite sqlite3'
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

async function initPostgres(): Promise<Database> {
  const pg = await initPgDatabase();
  _engine = 'postgres';
  return asSqliteDb(pg);
}

export async function initDB(): Promise<Database> {
  const url = resolvePgUrl();

  if (isPostgresUrl(url)) {
    _db = await initPostgres();
  } else if (isProd) {
    throw new Error(
      'PRODUÇÃO exige DATABASE_URL ou SUPABASE_DB_URL (Postgres). Veja SUPABASE_SETUP.md.'
    );
  } else {
    _db = await initSqlite();
  }

  const timestampType = _engine === 'postgres' ? 'TIMESTAMPTZ' : 'DATETIME';
  const autoIncrementId =
    _engine === 'postgres' ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';

  await _db.exec(`
    CREATE TABLE IF NOT EXISTS empresas (
      id TEXT PRIMARY KEY,
      cnpj TEXT UNIQUE NOT NULL,
      nome_empresa TEXT NOT NULL,
      slug TEXT UNIQUE,
      status TEXT DEFAULT 'trial',
      plan TEXT DEFAULT 'trial',
      criado_em ${timestampType} NOT NULL,
      expira_em ${timestampType} NOT NULL,
      google_review_url TEXT,
      voice_style TEXT,
      empresa_pai_id TEXT,
      whatsapp_suporte TEXT
    );
  `);
  await _db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id TEXT PRIMARY KEY,
      cnpj TEXT NOT NULL,
      nome_funcionario TEXT NOT NULL,
      empresa_id TEXT NOT NULL,
      senha_hash TEXT NOT NULL
    );
  `);
  await _db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id ${autoIncrementId},
      empresa_id TEXT,
      name TEXT,
      rating INTEGER,
      comment TEXT,
      ai_reply TEXT,
      ai_tags TEXT,
      createdAt ${timestampType} DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await _db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      id ${autoIncrementId},
      empresa_id TEXT,
      tipo TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      criado_em ${timestampType} DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await _db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      plan TEXT NOT NULL,
      month TEXT NOT NULL,
      tags INTEGER DEFAULT 0,
      respostas INTEGER DEFAULT 0,
      PRIMARY KEY (plan, month)
    );
  `);

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
  } else if (isProd && !adminMail) {
    console.warn('⚠️  ADMIN_EMAIL não definido.');
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
