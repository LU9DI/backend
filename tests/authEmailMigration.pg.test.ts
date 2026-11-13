/**
 * A migração de autenticação deve bloquear e-mails duplicados segundo a
 * mesma normalização usada pela aplicação (trim + lowercase), sem alterar
 * contas legadas nem criar parcialmente o índice único.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from 'pg';
import { initPgDatabase } from '../lib/db.pg.js';
import { runCentralMigrations } from '../lib/migrations.js';
import { createTestDatabase, dropTestDatabase } from './helpers/pg-test-utils.js';

test('migração bloqueia e-mails duplicados normalizados sem modificar usuários', async () => {
  const created = await createTestDatabase('pg_auth_duplicate_emails');
  const client = new Client({ connectionString: created.url });
  let db: Awaited<ReturnType<typeof initPgDatabase>> | null = null;

  try {
    await client.connect();
    await client.query(`
      CREATE TABLE usuarios (
        id TEXT PRIMARY KEY,
        cnpj TEXT NOT NULL,
        nome_funcionario TEXT NOT NULL,
        empresa_id TEXT NOT NULL,
        senha_hash TEXT NOT NULL,
        email TEXT
      )
    `);
    await client.query(
      `INSERT INTO usuarios (id, cnpj, nome_funcionario, empresa_id, senha_hash, email)
       VALUES
         ('user-a', '11111111111111', 'Conta A', 'empresa-a', 'hash-a', ' Lucas@Example.com '),
         ('user-b', '22222222222222', 'Conta B', 'empresa-b', 'hash-b', 'lucas@example.com'),
         ('user-c', '33333333333333', 'Conta C', 'empresa-c', 'hash-c', NULL)`,
    );
    await client.end();

    db = await initPgDatabase(created.url);
    await assert.rejects(
      () => runCentralMigrations(db!),
      (error: any) => {
        const message = String(error?.message || error);
        assert.match(message, /Migração de autenticação bloqueada/);
        assert.match(message, /1 grupo\(s\)/);
        assert.match(message, /2 usuário\(s\)/);
        assert.match(message, /trim \+ lowercase/);
        return true;
      },
    );

    const verify = new Client({ connectionString: created.url });
    await verify.connect();
    try {
      const users = await verify.query(
        'SELECT id, email FROM usuarios ORDER BY id',
      );
      assert.deepEqual(users.rows, [
        { id: 'user-a', email: ' Lucas@Example.com ' },
        { id: 'user-b', email: 'lucas@example.com' },
        { id: 'user-c', email: null },
      ], 'a migração não pode alterar nem excluir contas legadas');

      const index = await verify.query(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = 'usuarios'
            AND indexname IN ('idx_usuarios_email', 'ux_usuarios_email_normalized')`,
      );
      assert.deepEqual(index.rows, [], 'índices únicos não podem ser criados antes da correção dos conflitos');
    } finally {
      await verify.end();
    }
  } finally {
    await db?.close();
    if (client) await client.end().catch(() => undefined);
    await dropTestDatabase(created.name);
  }
});

test('e-mail legado com espaços continua localizável pela normalização canônica', async () => {
  const created = await createTestDatabase('pg_auth_trimmed_email');
  const client = new Client({ connectionString: created.url });
  let db: Awaited<ReturnType<typeof initPgDatabase>> | null = null;

  try {
    await client.connect();
    await client.query(`
      CREATE TABLE usuarios (
        id TEXT PRIMARY KEY,
        cnpj TEXT NOT NULL,
        nome_funcionario TEXT NOT NULL,
        empresa_id TEXT NOT NULL,
        senha_hash TEXT NOT NULL,
        email TEXT
      )
    `);
    await client.query(
      `INSERT INTO usuarios (id, cnpj, nome_funcionario, empresa_id, senha_hash, email)
       VALUES ('legacy-user', '11111111111111', 'Conta legada', 'empresa-a', 'hash', ' Lucas@Example.com ')`,
    );
    await client.end();

    db = await initPgDatabase(created.url);
    await runCentralMigrations(db);

    const found = await db.get<{ id: string }>(
      'SELECT id FROM usuarios WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) LIMIT 1',
      ['lucas@example.com'],
    );
    assert.equal(found?.id, 'legacy-user');

    const index = await db.get<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'ux_usuarios_email_normalized'`,
    );
    assert.match(index?.indexdef || '', /lower.*trim.*email/i);
  } finally {
    await db?.close();
    await client.end().catch(() => undefined);
    await dropTestDatabase(created.name);
  }
});
