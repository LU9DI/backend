/**
 * SQLite legado: a migração central precisa criar todas as colunas de reviews
 * usadas pela aplicação, com tipos compatíveis, sem recriar a tabela nem
 * perder dados históricos, e permanecer idempotente.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { closeDB, getDb, initDB } from '../lib/db.js';
import { REVIEW_COLUMNS, requireReviewSchema, tableColumnNames } from '../lib/migrations.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(backendRoot, 'data');
const files: string[] = [];

async function createLegacy(): Promise<string> {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, `legacy-reviews-central-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
  files.push(file);
  const { open } = await import('sqlite');
  const sqlite3 = (await import('sqlite3')).default;
  const db = await open({ filename: file, driver: sqlite3.Database });
  try {
    await db.exec(`CREATE TABLE reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT,
      name TEXT,
      rating INTEGER,
      comment TEXT,
      ai_reply TEXT,
      ai_tags TEXT,
      created_at DATETIME
    )`);
    await db.run(
      'INSERT INTO reviews (id, empresa_id, name, rating, comment, created_at) VALUES (?,?,?,?,?,?)',
      [1, 'empresa-legado', 'Cliente', 4, 'histórico', '2021-02-03 04:05:06'],
    );
  } finally {
    await db.close();
  }
  return file;
}

async function boot(file: string) {
  await closeDB();
  process.env.DATABASE_URL = '';
  process.env.SQLITE_DB_PATH = file;
  await initDB();
  return getDb();
}

test('SQLite legado recebe todas as colunas de reviews e preserva dados', async () => {
  const file = await createLegacy();
  const db = await boot(file);

  const columns = await tableColumnNames(db, 'reviews');
  const lower = new Set(columns.map((name) => name.toLowerCase()));
  for (const column of REVIEW_COLUMNS) {
    assert.ok(lower.has(column.toLowerCase()), `coluna reviews.${column} ausente (${columns.join(',')})`);
  }

  const info: any[] = await db.all('PRAGMA table_info(reviews)');
  const typeOf = (name: string) =>
    String(info.find((row) => String(row.name).toLowerCase() === name)?.type || '').toUpperCase();
  assert.equal(typeOf('is_test'), 'INTEGER');
  assert.equal(typeOf('ip_hash'), 'TEXT');
  assert.equal(typeOf('fraud_flags'), 'TEXT');
  assert.equal(typeOf('origin'), 'TEXT');
  assert.equal(typeOf('client_whatsapp'), 'TEXT');
  assert.equal(typeOf('sentiment'), 'TEXT');
  assert.equal(typeOf('sentiment_score'), 'REAL');
  assert.equal(typeOf('sentiment_source'), 'TEXT');
  assert.equal(typeOf('locale'), 'TEXT');
  assert.equal(typeOf('unidade_id'), 'TEXT');
  assert.equal(typeOf('treated_at'), 'TIMESTAMPTZ');
  assert.equal(typeOf('treated_note'), 'TEXT');

  const rows: any[] = await db.all('SELECT * FROM reviews ORDER BY id');
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].createdAt ?? rows[0].createdat), '2021-02-03 04:05:06');
  assert.equal(rows[0].sentiment, null);
  assert.equal(rows[0].treated_at, null);

  await requireReviewSchema(db);

  const before = await tableColumnNames(db, 'reviews');
  const db2 = await boot(file);
  const after = await tableColumnNames(db2, 'reviews');
  assert.deepEqual(after, before, 'segunda inicialização não pode alterar as colunas');
  const again: any[] = await db2.all('SELECT createdAt FROM reviews ORDER BY id');
  assert.equal(String(again[0].createdAt), '2021-02-03 04:05:06');
});

after(async () => {
  await closeDB();
  for (const file of files) fs.rmSync(file, { force: true });
});

test('SQLite: falha na migração limpa o estado e permite nova inicialização', async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, `legacy-reviews-failure-${Date.now()}.sqlite`);
  files.push(file);
  const { open } = await import('sqlite');
  const sqlite3 = (await import('sqlite3')).default;
  const setup = await open({ filename: file, driver: sqlite3.Database });
  await setup.exec('CREATE VIEW reviews AS SELECT 1 AS id');
  await setup.close();

  await closeDB();
  process.env.DATABASE_URL = '';
  process.env.SQLITE_DB_PATH = file;
  await assert.rejects(() => initDB(), /reviews|index|exist/i);
  assert.throws(() => getDb(), /não inicializado/);

  // Remove o bloqueio com uma conexão nova e tenta novamente.
  const fix = await open({ filename: file, driver: sqlite3.Database });
  await fix.exec('DROP VIEW reviews');
  await fix.close();

  const db = await initDB();
  const columns = await tableColumnNames(db, 'reviews');
  assert.ok(columns.some((name) => name.toLowerCase() === 'createdat'));
  assert.ok(columns.includes('sentiment_score'));
});
