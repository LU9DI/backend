/**
 * Migração histórica de `reviews.createdAt` no PostgreSQL.
 *
 * Variantes reais:
 * - `createdat` — nome gerado pela DDL original (`createdAt` sem aspas);
 * - `created_at` — schemas antigos em snake_case;
 * - `"createdAt"` — coluna criada com aspas por outra ferramenta.
 *
 * A migração precisa preservar os valores históricos, não preencher lacunas
 * com `NOW()` e manter as consultas `createdAt` da aplicação funcionando.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from 'pg';
import { closeDB, getDb, initDB } from '../lib/db.js';
import { tableColumnNames } from '../lib/migrations.js';
import { createTestDatabase, dropTestDatabase } from './helpers/pg-test-utils.js';

async function withClient<T>(url: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function boot(url: string) {
  await closeDB();
  process.env.DATABASE_URL = url;
  await initDB();
  return getDb();
}

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

// O adapter do backend reescreve `createdAt` para `"createdAt"`; a coluna
// canônica é exatamente essa e as fontes históricas seguem intactas.
function canonicalDate(row: any): unknown {
  return row.createdat ?? row.createdAt ?? row.created_at;
}

test('PostgreSQL: created_at histórico é copiado para createdat sem perder datas', async () => {
  const created = await createTestDatabase('pg_reviews_created_at');
  const previousUrl = process.env.DATABASE_URL;
  try {
    await withClient(created.url, async (client) => {
      await client.query(`
        CREATE TABLE reviews (
          id SERIAL PRIMARY KEY,
          empresa_id TEXT,
          name TEXT,
          rating INTEGER,
          comment TEXT,
          ai_reply TEXT,
          ai_tags TEXT,
          created_at TIMESTAMPTZ
        )`);
      await client.query(
        `INSERT INTO reviews (id, empresa_id, name, rating, comment, created_at) VALUES
          (1, 'empresa-historica', 'Antigo', 5, 'antigo', '2020-05-06T07:08:09Z'),
          (2, 'empresa-historica', 'Recente', 2, 'recente', '2023-11-12T13:14:15Z'),
          (3, 'empresa-historica', 'Sem data', 4, 'sem data', NULL)`,
      );
      // Mantém a sequência SERIAL coerente com os IDs históricos inseridos.
      await client.query(`SELECT setval(pg_get_serial_sequence('reviews', 'id'), 3, true)`);
    });

    const db = await boot(created.url);
    const columns = await tableColumnNames(db, 'reviews');
    assert.ok(columns.includes('createdAt'), `coluna canônica createdAt ausente: ${columns.join(',')}`);
    assert.ok(columns.includes('created_at'), 'coluna histórica não pode ser removida');

    const rows = await db.all('SELECT id, createdAt, created_at FROM reviews ORDER BY id');
    assert.equal(rows.length, 3);
    assert.equal(iso(canonicalDate(rows[0])), '2020-05-06T07:08:09.000Z');
    assert.equal(iso(canonicalDate(rows[1])), '2023-11-12T13:14:15.000Z');
    assert.equal(iso(rows[0].created_at), '2020-05-06T07:08:09.000Z');
    assert.equal(canonicalDate(rows[2]), null, 'lacuna histórica não pode ser preenchida com NOW()');

    // Consultas reais da aplicação (lib/quota, lib/reviewFraud, cache/rotas).
    const noPeriodo = await db.get(
      'SELECT COUNT(*) AS c FROM reviews WHERE empresa_id = ? AND createdAt >= ? AND createdAt < ?',
      ['empresa-historica', '2020-01-01T00:00:00Z', '2024-01-01T00:00:00Z'],
    );
    assert.equal(Number(noPeriodo.c), 2, 'consulta por createdAt deve enxergar as datas históricas');

    const ordenado = await db.all(
      'SELECT id, createdAt FROM reviews WHERE empresa_id = ? ORDER BY createdAt DESC NULLS LAST',
      ['empresa-historica'],
    );
    assert.deepEqual(ordenado.map((row: any) => Number(row.id)), [2, 1, 3]);
    assert.equal(iso(canonicalDate(ordenado[0])), '2023-11-12T13:14:15.000Z');

    // Novas linhas usam o default aplicado depois do backfill.
    await db.run('INSERT INTO reviews (empresa_id, name, rating) VALUES (?,?,?)', ['empresa-historica', 'Novo', 5]);
    const novo: any = await db.get('SELECT createdAt FROM reviews WHERE name = ?', ['Novo']);
    assert.ok(canonicalDate(novo), 'review novo deve receber CURRENT_TIMESTAMP');
    assert.ok(
      new Date(String(canonicalDate(novo))).getTime() >= Date.now() - 120_000,
      'default de novas linhas deve ser o momento da inserção',
    );

    // Restart não altera os valores históricos.
    const db2 = await boot(created.url);
    const depois = await db2.all('SELECT id, createdAt FROM reviews WHERE id IN (1,2) ORDER BY id');
    assert.equal(iso(canonicalDate(depois[0])), '2020-05-06T07:08:09.000Z');
    assert.equal(iso(canonicalDate(depois[1])), '2023-11-12T13:14:15.000Z');
  } finally {
    await closeDB();
    process.env.DATABASE_URL = previousUrl;
    await dropTestDatabase(created.name);
  }
});

test('PostgreSQL: coluna legada createdat é copiada para createdAt', async () => {
  const created = await createTestDatabase('pg_reviews_quoted');
  const previousUrl = process.env.DATABASE_URL;
  try {
    await withClient(created.url, async (client) => {
      await client.query(`
        CREATE TABLE reviews (
          id SERIAL PRIMARY KEY,
          empresa_id TEXT,
          name TEXT,
          rating INTEGER,
          comment TEXT,
          ai_reply TEXT,
          ai_tags TEXT,
          createdat TIMESTAMPTZ
        )`);
      await client.query(
        `INSERT INTO reviews (id, empresa_id, name, rating, comment, createdat)
         VALUES (1, 'empresa-quoted', 'Antigo', 5, 'antigo', '2019-03-04T05:06:07Z')`,
      );
    });

    const db = await boot(created.url);
    const columns = await tableColumnNames(db, 'reviews');
    assert.ok(columns.includes('createdAt'), 'coluna canônica criada pela migração deve existir');
    assert.ok(columns.includes('createdat'), 'a coluna legada sem aspas deve continuar existindo');

    const row: any = await db.get('SELECT id, createdAt, createdat AS legado FROM reviews WHERE id = 1');
    assert.equal(iso(canonicalDate(row)), '2019-03-04T05:06:07.000Z');
    assert.equal(iso(row.legado), '2019-03-04T05:06:07.000Z');
  } finally {
    await closeDB();
    process.env.DATABASE_URL = previousUrl;
    await dropTestDatabase(created.name);
  }
});

test('PostgreSQL: backfill não sobrescreve createdat já válido', async () => {
  const created = await createTestDatabase('pg_reviews_no_overwrite');
  const previousUrl = process.env.DATABASE_URL;
  try {
    await withClient(created.url, async (client) => {
      await client.query(`
        CREATE TABLE reviews (
          id SERIAL PRIMARY KEY,
          empresa_id TEXT,
          name TEXT,
          rating INTEGER,
          comment TEXT,
          ai_reply TEXT,
          ai_tags TEXT,
          createdat TIMESTAMPTZ,
          created_at TIMESTAMPTZ
        )`);
      await client.query(
        `INSERT INTO reviews (id, empresa_id, name, rating, comment, createdat, created_at) VALUES
          (1, 'empresa-overwrite', 'Canônico', 5, 'canonico', '2018-02-03T04:05:06Z', '2022-09-09T10:11:12Z'),
          (2, 'empresa-overwrite', 'Lacuna', 5, 'lacuna', NULL, '2021-07-08T09:10:11Z')`,
      );
    });

    const db = await boot(created.url);
    const rows = await db.all('SELECT id, createdAt, created_at, createdat FROM reviews ORDER BY id');
    assert.equal(iso(canonicalDate(rows[0])), '2018-02-03T04:05:06.000Z', 'data canônica válida não pode ser sobrescrita');
    assert.equal(iso(rows[0].created_at), '2022-09-09T10:11:12.000Z', 'coluna histórica permanece intacta');
    assert.equal(iso(rows[0].createdat), '2018-02-03T04:05:06.000Z', 'fonte createdat permanece intacta');
    assert.equal(iso(canonicalDate(rows[1])), '2021-07-08T09:10:11.000Z', 'lacuna é preenchida com a fonte histórica');
  } finally {
    await closeDB();
    process.env.DATABASE_URL = previousUrl;
    await dropTestDatabase(created.name);
  }
});
