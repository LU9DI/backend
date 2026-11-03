/**
 * initDB() deve ser atômico: se a conexão abre mas a migração falha, fecha a
 * instância criada, limpa o estado, propaga o erro original e permite nova
 * tentativa. Uma instância anterior (de outra chamada) nunca é fechada.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from 'pg';
import { closeDB, getDb, initDB } from '../lib/db.js';
import { tableColumns } from '../lib/migrations.js';
import {
  createTestDatabase,
  dropTestDatabase,
  withAdminClient,
} from './helpers/pg-test-utils.js';

async function withRaw(url: string, sql: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function connectionsFor(database: string): Promise<number> {
  return withAdminClient(async (client) => {
    const result = await client.query(
      'SELECT count(*)::int AS c FROM pg_stat_activity WHERE datname = $1',
      [database],
    );
    return Number(result.rows[0].c);
  });
}

async function waitForNoConnections(database: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  let count = await connectionsFor(database);
  while (count !== 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    count = await connectionsFor(database);
  }
  return count;
}

test('falha na migração de initDB fecha o pool, propaga o erro e permite nova tentativa', async () => {
  const created = await createTestDatabase('pg_init_failure_recovery');
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = created.url;
  try {
    // Bloqueia a tabela reviews com uma view: a migração falha de verdade.
    await withRaw(created.url, 'CREATE VIEW reviews AS SELECT 1 AS id');

    await assert.rejects(
      () => initDB(),
      (error: any) => {
        assert.match(String(error?.message || error), /reviews|relation|index/i);
        console.log('erro original propagado:', error?.message, 'code=', error?.code);
        return true;
      },
      'initDB deve rejeitar quando a migração falha',
    );

    // Estado limpo: nenhum banco ativo e nenhuma conexão pendurada.
    assert.throws(() => getDb(), /não inicializado/, 'getDb não pode devolver instância após falha');
    const remaining = await waitForNoConnections(created.name);
    assert.equal(remaining, 0, `pool deveria estar fechado, mas há ${remaining} conexão(ões)`);

    // Corrige o schema e tenta novamente: recuperação completa.
    await withRaw(created.url, 'DROP VIEW reviews');
    const db = await initDB();
    const columns = await tableColumns(db, 'reviews');
    for (const column of ['createdat', 'is_test', 'ip_hash', 'sentiment_score', 'treated_at']) {
      assert.ok(columns.includes(column), `recuperação deve criar reviews.${column}`);
    }
    await closeDB();
  } finally {
    await closeDB().catch(() => undefined);
    process.env.DATABASE_URL = previousUrl;
    await dropTestDatabase(created.name);
  }
});

test('falha de uma nova initDB não fecha a instância de uma chamada anterior', async () => {
  const good = await createTestDatabase('pg_init_keep_previous');
  const bad = await createTestDatabase('pg_init_new_failure');
  const previousUrl = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = good.url;
    const first = await initDB();
    await first.run('INSERT INTO empresas (id, cnpj, nome_empresa, criado_em, expira_em) VALUES (?,?,?,?,?)', [
      'empresa-keep',
      '12345678000199',
      'Empresa Keep',
      new Date().toISOString(),
      new Date(Date.now() + 86400000).toISOString(),
    ]);

    await withRaw(bad.url, 'CREATE VIEW reviews AS SELECT 1 AS id');
    process.env.DATABASE_URL = bad.url;
    await assert.rejects(() => initDB(), /reviews|relation|index/i);

    // A instância anterior continua ativa e utilizável.
    assert.equal(getDb(), first, 'getDb deve continuar apontando para a instância anterior');
    const row = await getDb().get('SELECT nome_empresa FROM empresas WHERE id = ?', ['empresa-keep']);
    assert.equal(String(row?.nome_empresa), 'Empresa Keep');
    assert.equal(await waitForNoConnections(bad.name), 0, 'a instância que falhou não pode manter pool aberto');

    await closeDB();
  } finally {
    await closeDB().catch(() => undefined);
    process.env.DATABASE_URL = previousUrl;
    await dropTestDatabase(good.name);
    await dropTestDatabase(bad.name);
  }
});
