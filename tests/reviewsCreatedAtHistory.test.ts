/**
 * Migração histórica de `reviews.createdAt` no SQLite.
 *
 * Schemas antigos podem ter a data como `created_at`, `createdat` ou
 * `createdAt`. A migração deve preservar os valores existentes, nunca
 * substituí-los por `CURRENT_TIMESTAMP`, e manter as consultas da aplicação
 * (que usam `createdAt`) funcionando.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { closeDB, getDb, initDB } from '../lib/db.js';
import { tableColumnNames } from '../lib/migrations.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(backendRoot, 'data');
const createdFiles: string[] = [];

const HISTORICAL = [
  { id: 1, empresa_id: 'empresa-historica', rating: 5, comment: 'antigo', date: '2020-05-06 07:08:09' },
  { id: 2, empresa_id: 'empresa-historica', rating: 2, comment: 'recente', date: '2023-11-12 13:14:15' },
];

async function createLegacyDatabase(column: string, extraColumns = ''): Promise<string> {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, `legacy-reviews-${column}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
  createdFiles.push(file);
  const { open } = await import('sqlite');
  const sqlite3 = (await import('sqlite3')).default;
  const legacy = await open({ filename: file, driver: sqlite3.Database });
  try {
    await legacy.exec(`CREATE TABLE reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT,
      name TEXT,
      rating INTEGER,
      comment TEXT,
      ai_reply TEXT,
      ai_tags TEXT,
      ${column} DATETIME DEFAULT CURRENT_TIMESTAMP${extraColumns}
    )`);
    for (const row of HISTORICAL) {
      await legacy.run(
        `INSERT INTO reviews (id, empresa_id, name, rating, comment, ${column}) VALUES (?,?,?,?,?,?)`,
        [row.id, row.empresa_id, 'Cliente', row.rating, row.comment, row.date],
      );
    }
    await legacy.run(
      `INSERT INTO reviews (id, empresa_id, name, rating, comment, ${column}) VALUES (?,?,?,?,?,NULL)`,
      [3, 'empresa-historica', 'Sem data', 4, 'sem data'],
    );
  } finally {
    await legacy.close();
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

async function assertHistoryPreserved(db: any) {
  const rows = await db.all('SELECT * FROM reviews ORDER BY id');
  assert.equal(rows.length, 3);
  const createdAt = (row: any) =>
    'createdAt' in row ? row.createdAt : 'createdat' in row ? row.createdat : row.created_at;
  assert.equal(String(createdAt(rows[0])), HISTORICAL[0].date);
  assert.equal(String(createdAt(rows[1])), HISTORICAL[1].date);
  assert.equal(createdAt(rows[2]), null, 'linha sem data histórica não pode ser inventada com NOW()');

  // Consulta usada pela aplicação (lib/quota, lib/reviewFraud, rotas).
  const noPeriodo = await db.get(
    'SELECT COUNT(*) AS c FROM reviews WHERE empresa_id = ? AND createdAt >= ? AND createdAt < ?',
    ['empresa-historica', '2020-01-01 00:00:00', '2024-01-01 00:00:00'],
  );
  assert.equal(Number(noPeriodo.c), 2, 'consulta por createdAt deve enxergar as datas históricas');

  const ordenado = await db.all(
    'SELECT id FROM reviews WHERE empresa_id = ? ORDER BY createdAt DESC, id DESC',
    ['empresa-historica'],
  );
  assert.equal(Number(ordenado[0].id), 2, 'ordenação por createdAt deve refletir a data histórica mais recente');
}

test('preserva datas históricas em created_at (snake_case)', async () => {
  const file = await createLegacyDatabase('created_at');
  const db = await boot(file);
  const columns = await tableColumnNames(db, 'reviews');
  assert.ok(columns.includes('created_at'), 'coluna legada não pode ser destruída');
  assert.ok(columns.some((name) => name.toLowerCase() === 'createdat'), 'coluna canônica deve existir');
  await assertHistoryPreserved(db);
  const legado = await db.all('SELECT id, created_at FROM reviews ORDER BY id');
  assert.equal(String(legado[0].created_at), HISTORICAL[0].date);
  assert.equal(String(legado[1].created_at), HISTORICAL[1].date);

  // Reinicialização (restart) não pode alterar as datas.
  const db2 = await boot(file);
  await assertHistoryPreserved(db2);

  // Inserção no formato da aplicação (services/reviewService.ts) continua
  // preenchendo createdAt mesmo sem default na coluna recém-criada.
  await db2.run(
    'INSERT INTO reviews (empresa_id,name,rating,comment,ai_reply,ai_tags,createdAt) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)',
    ['empresa-historica', 'Novo', 5, 'novo', null, null],
  );
  const novo = await db2.get('SELECT createdAt FROM reviews WHERE name = ?', ['Novo']);
  assert.ok(novo?.createdAt, 'review novo deve ter createdAt preenchido');
});

test('preserva datas históricas em createdat (minúsculo)', async () => {
  const file = await createLegacyDatabase('createdat');
  const db = await boot(file);
  const columns = await tableColumnNames(db, 'reviews');
  assert.equal(
    columns.filter((name) => name.toLowerCase() === 'createdat').length,
    1,
    'SQLite não pode ganhar coluna duplicada para a mesma data',
  );
  await assertHistoryPreserved(db);
});

test('preserva datas históricas em createdAt (schema original)', async () => {
  const file = await createLegacyDatabase('createdAt');
  const db = await boot(file);
  assert.ok((await tableColumnNames(db, 'reviews')).includes('createdAt'));
  await assertHistoryPreserved(db);
});

test('preserva datas anteriores mesmo quando a coluna é adicionada com DEFAULT legado', async () => {
  const file = await createLegacyDatabase('created_at', ', is_test INTEGER DEFAULT 0');
  const db = await boot(file);
  await assertHistoryPreserved(db);
});

after(async () => {
  await closeDB();
  for (const file of createdFiles) fs.rmSync(file, { force: true });
});
