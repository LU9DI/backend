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
import { initPgDatabase, isPostgresUrl, asSqliteDb } from './db.pg.js';
import { runCentralMigrations } from './migrations.js';

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

/**
 * Fila global de transações (SQLite).
 *
 * No SQLite o processo usa um único handle de banco. Duas transações
 * intercaladas por `await` no mesmo processo geram "cannot start a transaction
 * within a transaction" e permitem efeitos duplicados. Serializar elimina a
 * colisão: cada transação começa somente depois que a anterior terminou. Não
 * existe chamada aninhada de `withDbTransaction` no código atual — se passar a
 * existir, o aninhamento precisa de SAVEPOINT em vez desta fila.
 *
 * No Postgres o shim expõe `transaction()` com client fixado e a transação é
 * real (BEGIN/COMMIT/ROLLBACK na mesma conexão) — a fila não é necessária.
 */
let transactionQueue: Promise<unknown> = Promise.resolve();

export async function withDbTransaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
  const db: any = getDb();
  if (typeof db.transaction === 'function') {
    return db.transaction(async (tx: any) => fn(tx as Database));
  }
  const run = transactionQueue.then(async () => {
    await db.exec('BEGIN');
    try {
      const result = await fn(db as Database);
      await db.exec('COMMIT');
      return result;
    } catch (error) {
      try { await db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  });
  transactionQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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
  const previousDb = _db;
  const previousEngine = _engine;
  let created: Database | null = null;

  try {
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
      created = await initPostgresWithUrl(url);
    } else {
      const url = process.env.DATABASE_URL?.trim();
      if (isPostgresUrl(url)) {
        created = await initPostgres();
      } else if (isProd) {
        throw new Error(
          'DATABASE_URL com uma URL PostgreSQL válida é obrigatória em produção. SQLite não é permitido.'
        );
      } else {
        created = await initSqlite();
      }
    }

    // Toda a DDL do núcleo (reviews, auth/MFA, dot_action_queue/audit e
    // tabelas base) vive em lib/migrations.ts e roda sob advisory lock global
    // no PostgreSQL. Caminhos de requisição nunca migram schema.
    await runCentralMigrations(created);
    console.log('Schema inicializado (migrações centrais idempotentes)');

    const adminMail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const adminPass = process.env.ADMIN_PASSWORD || '';
    if (adminMail && adminPass.length >= 12) {
      const adminExiste = await created.get(
        'SELECT id, empresa_id FROM usuarios WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))',
        [adminMail]
      );
      if (adminExiste && String(adminExiste.empresa_id) !== 'admin') {
        throw new Error(
          'ADMIN_EMAIL já pertence a uma conta de tenant. Por segurança, o backend não promoverá essa conta automaticamente; mova a identidade administrativa para um usuário dedicado com empresa_id=admin.'
        );
      }
      if (!adminExiste) {
        const hash = await bcrypt.hash(adminPass, 12);
        await created.run(
          'INSERT INTO usuarios (id, cnpj, nome_funcionario, empresa_id, senha_hash, email) VALUES (?, ?, ?, ?, ?, ?)',
          [crypto.randomUUID(), '00000000000000', 'Admin', 'admin', hash, adminMail]
        );
        console.log(`🔑 Admin criado: ${adminMail}`);
      }
    } else if (isProd && adminMail && adminPass.length > 0 && adminPass.length < 12) {
      console.warn('⚠️  ADMIN_PASSWORD curta (<12) — admin não será seedado automaticamente.');
    }

    _db = created;
    return created;
  } catch (error) {
    // Falha em migração/verificação: fecha SOMENTE a instância criada por
    // esta chamada, restaura o estado anterior e propaga o erro original.
    if (created && created !== previousDb) {
      try {
        const candidate = created as unknown as { close?: () => Promise<void> };
        if (typeof candidate.close === 'function') await candidate.close();
      } catch (closeError: any) {
        console.error('initDB: falha ao fechar instância após erro de inicialização:', closeError?.message || closeError);
      }
    }
    _db = previousDb;
    _engine = previousEngine;
    throw error;
  }
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
