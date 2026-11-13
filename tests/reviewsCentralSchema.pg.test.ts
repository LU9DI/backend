/**
 * Banco legado PostgreSQL com apenas as colunas originais de `reviews`.
 * A migração central deve adicionar todas as colunas usadas pela aplicação,
 * com tipos compatíveis, preservando os dados e falhando explicitamente quando
 * uma coluna obrigatória for removida.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from 'pg';
import { closeDB, initDB } from '../lib/db.js';
import { ensureReviewFraudColumns } from '../lib/reviewFraud.js';
import { ensureSentimentColumns } from '../services/sentimentBackfill.js';
import { ensureReviewTreatmentColumns } from '../lib/lgpd.js';
import { REVIEW_COLUMNS, listIndexDefinitions, requireReviewSchema, tableColumnNames } from '../lib/migrations.js';
import { createTestDatabase, dropTestDatabase } from './helpers/pg-test-utils.js';

const EXPECTED_TYPES: Record<string, string> = {
  createdat: 'timestamp with time zone',
  is_test: 'integer',
  ip_hash: 'text',
  fraud_flags: 'text',
  origin: 'text',
  client_whatsapp: 'text',
  sentiment: 'text',
  sentiment_score: 'double precision',
  sentiment_source: 'text',
  locale: 'text',
  unidade_id: 'text',
  treated_at: 'timestamp with time zone',
  treated_note: 'text',
};

test('PostgreSQL legado recebe todas as colunas de reviews sem perder dados', async () => {
  const created = await createTestDatabase('pg_reviews_central');
  const previousUrl = process.env.DATABASE_URL;
  try {
    const client = new Client({ connectionString: created.url });
    await client.connect();
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
      `INSERT INTO reviews (id, empresa_id, name, rating, comment, created_at)
       VALUES (1, 'empresa-legado', 'Cliente', 4, 'histórico', '2021-02-03T04:05:06Z')`,
    );
    await client.end();

    process.env.DATABASE_URL = created.url;
    const db = await initDB();

    const columns = await tableColumnNames(db, 'reviews');
    for (const column of REVIEW_COLUMNS) {
      assert.ok(
        columns.some((name) => name.toLowerCase() === column.toLowerCase()),
        `coluna reviews.${column} ausente (${columns.join(',')})`,
      );
    }

    const tipos = await db.all(
      `SELECT column_name AS name, data_type AS type
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'reviews'`,
    );
    for (const [column, expected] of Object.entries(EXPECTED_TYPES)) {
      const row: any = tipos.find((entry: any) => String(entry.name).toLowerCase() === column);
      assert.ok(row, `coluna ${column} não encontrada em information_schema`);
      assert.equal(String(row.type), expected, `tipo inesperado para reviews.${column}`);
    }

    const row: any = await db.get('SELECT createdAt, sentiment, treated_at FROM reviews WHERE id = 1');
    assert.equal(new Date(String(row.createdat ?? row.createdAt)).toISOString(), '2021-02-03T04:05:06.000Z');
    assert.equal(row.sentiment, null);
    assert.equal(row.treated_at, null);

    await requireReviewSchema(db);
    await ensureReviewFraudColumns(db);
    await ensureSentimentColumns(db);
    await ensureReviewTreatmentColumns(db);

    assert.equal((await listIndexDefinitions(db, ['reviews'])).some((index) => index.name === 'idx_reviews_empresa'), true);
    await closeDB();
  } finally {
    await closeDB().catch(() => undefined);
    process.env.DATABASE_URL = previousUrl;
    await dropTestDatabase(created.name);
  }
});

test('coluna obrigatória ausente falha explicitamente (sem DDL silenciosa)', async () => {
  const created = await createTestDatabase('pg_reviews_missing');
  const previousUrl = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = created.url;
    const db = await initDB();

    await db.exec('ALTER TABLE reviews DROP COLUMN locale');
    await assert.rejects(
      () => requireReviewSchema(db),
      (error: any) => {
        assert.match(String(error?.message || error), /Schema desatualizado/);
        assert.match(String(error?.message || error), /reviews\.locale/i);
        return true;
      },
      'requireReviewSchema deve falhar de forma explícita',
    );

    await db.exec('ALTER TABLE reviews DROP COLUMN fraud_flags');
    await assert.rejects(() => ensureReviewFraudColumns(db), /reviews\.fraud_flags/i);
    await db.exec('ALTER TABLE reviews DROP COLUMN sentiment_source');
    await assert.rejects(() => ensureSentimentColumns(db), /reviews\.sentiment_source/i);

    // Nenhuma tentativa automática de recriar a coluna.
    assert.equal((await tableColumnNames(db, 'reviews')).includes('locale'), false);
    await closeDB();
  } finally {
    await closeDB().catch(() => undefined);
    process.env.DATABASE_URL = previousUrl;
    await dropTestDatabase(created.name);
  }
});
