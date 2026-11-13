/**
 * Guarda de segurança de `tests/helpers/pg-test-utils.ts`.
 *
 * O teste PostgreSQL cria e derruba bancos NO SERVIDOR apontado por
 * `DATABASE_URL`. Sem a trava, uma URL real executaria DDL/DML em produção.
 * Estes testes provam a recusa ANTES de qualquer conexão.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { assertSafeTestDatabaseUrl } from './helpers/pg-test-utils.js';

const ENV_KEY = 'FILTERA_PG_TEST_ALLOWED_HOSTS';
let saved: string | undefined;

function withAllowed(value: string | undefined, fn: () => void) {
  saved = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  }
}

describe('guarda anti-produção dos testes PostgreSQL', () => {
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  test('aceita localhost, 127.0.0.1 e ::1', () => {
    withAllowed(undefined, () => {
      assertSafeTestDatabaseUrl('postgresql://u:p@localhost:5432/filtra_x');
      assertSafeTestDatabaseUrl('postgresql://u:p@127.0.0.1:5432/filtra_x');
      assertSafeTestDatabaseUrl('postgresql://u:p@[::1]:5432/filtra_x');
      assertSafeTestDatabaseUrl('postgres://u:p@localhost/filtra_x');
    });
  });

  test('recusa hosts remotos que não estejam na allowlist', () => {
    withAllowed(undefined, () => {
      for (const url of [
        'postgresql://u:p@db.producao.example.com:5432/filtra',
        'postgresql://u:p@10.0.0.5:5432/filtra',
        'postgresql://u:p@render-postgres:5432/filtra',
        'postgresql://u:p@supabase.co:5432/postgres',
      ]) {
        assert.throws(
          () => assertSafeTestDatabaseUrl(url),
          /recusada.*FILTERA_PG_TEST_ALLOWED_HOSTS/s,
          url,
        );
      }
    });
  });

  test('aceita host remoto explicitamente listado na allowlist', () => {
    withAllowed('db.interno.test, outro.internal', () => {
      assertSafeTestDatabaseUrl('postgresql://u:p@db.interno.test:5432/filtra_x');
      assertSafeTestDatabaseUrl('postgresql://u:p@outro.internal:5432/filtra_x');
      assert.throws(
        () => assertSafeTestDatabaseUrl('postgresql://u:p@db.interno.test2:5432/filtra_x'),
        /recusada/s,
      );
    });
  });

  test('recusa URL inválida e scheme não-postgres', () => {
    withAllowed(undefined, () => {
      assert.throws(() => assertSafeTestDatabaseUrl('not-a-url'), /inválida/i);
      assert.throws(() => assertSafeTestDatabaseUrl('sqlite:///tmp/x.sqlite'), /postgres/i);
      assert.throws(() => assertSafeTestDatabaseUrl('mysql://u:p@localhost/db'), /postgres/i);
    });
  });
});
