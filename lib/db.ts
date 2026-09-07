/**
 * Inicialização e acesso ao banco.
 * - Dev / testes: SQLite (padrão)
 * - Produção: Postgres obrigatório (DATABASE_URL), salvo SQLITE_ALLOW_PROD=1
 *
 * Tipos de data: TIMESTAMP (não DATETIME) — portável SQLite + Postgres.
 */
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import sqlite3 from 'sqlite3';
import { open, type Database } from 'sqlite';
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

/** Health real: SELECT 1. */
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
  const dbPath =
    process.env.SQLITE_DB_PATH ||
    (isProd
      ? '/data/database.sqlite'
      : path.resolve(__dirname, '..', '..', 'data', 'database.sqlite'));

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  _engine = 'sqlite';
  console.log(`💾 SQLite: ${dbPath}`);
  return db;
}

async function initPostgres(): Promise<Database> {
  const url = process.env.DATABASE_URL!.trim();
  const pg = await initPgDatabase(url);
  _engine = 'postgres';
  console.log('🐘 Postgres conectado (DATABASE_URL)');
  return asSqliteDb(pg);
}

export async function initDB(): Promise<Database> {
  const url = process.env.DATABASE_URL?.trim();

  if (isPostgresUrl(url)) {
    _db = await initPostgres();
  } else if (isProd && process.env.SQLITE_ALLOW_PROD !== '1') {
    throw new Error(
      'Produção exige DATABASE_URL Postgres. Defina no Render (filtra-ia-db) ou SQLITE_ALLOW_PROD=1.'
    );
  } else {
    if (isProd) {
      console.warn('⚠️  SQLITE_ALLOW_PROD=1 — dados no disco efêmero do Render podem sumir.');
    }
    _db = await initSqlite();
  }

  await _db.exec(`
    CREATE TABLE IF NOT EXISTS empresas (
      id TEXT PRIMARY KEY,
      cnpj TEXT UNIQUE NOT NULL,
      nome_empresa TEXT NOT NULL,
      slug TEXT UNIQUE,
      status TEXT DEFAULT 'trial',
      plan TEXT DEFAULT 'trial',
      criado_em TIMESTAMP NOT NULL,
      expira_em TIMESTAMP NOT NULL,
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
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await _db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT,
      tipo TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

  const adminMail = (process.env.ADMIN_EMAIL || 'admin@seusaas.com').trim().toLowerCase();
  const adminExiste = await _db.get('SELECT * FROM usuarios WHERE email = ?', [adminMail]);
  if (!adminExiste) {
    const senhaPadrao = process.env.ADMIN_PASSWORD || 'MudeEstaSenha123!';
    const hash = await bcrypt.hash(senhaPadrao, 12);
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
