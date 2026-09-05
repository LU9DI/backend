/**
 * Inicialização e acesso ao SQLite.
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProd = process.env.NODE_ENV === 'production';

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) throw new Error('Banco ainda não inicializado. Chame initDB() primeiro.');
  return _db;
}

export async function initDB(): Promise<Database> {
  const dbPath =
    process.env.SQLITE_DB_PATH ||
    (isProd ? '/data/database.sqlite' : path.resolve(__dirname, '..', '..', 'data', 'database.sqlite'));

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = await open({ filename: dbPath, driver: sqlite3.Database });

  await _db.exec(`
    CREATE TABLE IF NOT EXISTS empresas (
      id TEXT PRIMARY KEY,
      cnpj TEXT UNIQUE NOT NULL,
      nome_empresa TEXT NOT NULL,
      slug TEXT UNIQUE,
      status TEXT DEFAULT 'trial',
      plan TEXT DEFAULT 'trial',
      criado_em DATETIME NOT NULL,
      expira_em DATETIME NOT NULL,
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
      senha_hash TEXT NOT NULL,
      FOREIGN KEY (empresa_id) REFERENCES empresas(id)
    );
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
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await _db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT,
      tipo TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
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

  const adminMail = (process.env.ADMIN_EMAIL || 'admin@seusaas.com').trim().toLowerCase();
  const adminExiste = await _db.get('SELECT * FROM usuarios WHERE email = ?', [adminMail]);
  if (!adminExiste) {
    const senhaPadrao = process.env.ADMIN_PASSWORD || 'MudeEstaSenha123!';
    const hash = await bcrypt.hash(senhaPadrao, 12);
    await _db.run(
      'INSERT INTO usuarios (id, cnpj, nome_funcionario, empresa_id, senha_hash, email) VALUES (?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), '00000000000000', 'Admin', 'admin', hash, adminMail]
    );
    console.log(`🔑 Admin criado: ${adminMail}`);
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
