/**
 * Guardas de arquitetura das migrações (sem banco):
 * - caminhos de requisição não executam DDL;
 * - `requireSchema` apenas verifica, nunca corrige;
 * - o adapter PostgreSQL não mantém pool global mutável;
 * - a chave do advisory lock é estável.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Database } from 'sqlite';
import { PG_MIGRATION_LOCK_KEY, requireReviewSchema, requireSchema } from '../lib/migrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');

function source(relative: string): string {
  return fs.readFileSync(path.join(backendRoot, relative), 'utf8');
}

function fakeDb(
  tables: Record<string, string[]>,
  indexes: string[] = [],
): { db: Database; execCalls: string[] } {
  const execCalls: string[] = [];
  const db = {
    async all(sql: string) {
      const pragma = /PRAGMA\s+table_info\(\s*([\w]+)\s*\)/i.exec(sql);
      if (pragma) return (tables[pragma[1]] || []).map((name) => ({ name }));
      if (/PRAGMA\s+index_list/i.test(sql)) return indexes.map((name) => ({ name }));
      return [];
    },
    async get(sql: string, params: any[] = []) {
      if (/pg_indexes/i.test(sql)) return indexes.includes(String(params[0])) ? { ok: 1 } : undefined;
      return undefined;
    },
    async exec(sql: string) {
      execCalls.push(sql);
    },
  } as unknown as Database;
  return { db, execCalls };
}

test('requireSchema valida sem executar DDL quando o schema está completo', async () => {
  const { db, execCalls } = fakeDb(
    { usuarios: ['id', 'email', 'mfa_secret', 'mfa_enabled', 'mfa_backup_hashes', 'mfa_pending_secret'] },
    ['idx_usuarios_email'],
  );
  await requireSchema(db, {
    tables: ['usuarios'],
    columns: { usuarios: ['email', 'mfa_secret', 'mfa_enabled', 'mfa_backup_hashes', 'mfa_pending_secret'] },
    indexes: [{ table: 'usuarios', name: 'idx_usuarios_email' }],
  });
  assert.deepEqual(execCalls, [], 'verificação de schema não pode executar DDL');
});

test('requireSchema falha explicitamente quando uma estrutura obrigatória está ausente', async () => {
  const { db, execCalls } = fakeDb({ usuarios: ['id'] }, []);
  await assert.rejects(
    () => requireSchema(db, { columns: { usuarios: ['email'] }, tables: ['password_resets'] }),
    (error: any) => {
      const message = String(error?.message || error);
      assert.match(message, /Schema desatualizado/);
      assert.match(message, /usuarios\.email/);
      assert.match(message, /password_resets/);
      return true;
    },
  );
  assert.deepEqual(execCalls, [], 'falha de verificação não pode tentar corrigir o schema');
});

test('caminhos de requisição não contêm DDL', () => {
  const files = [
    'passwordResetRoutes.ts',
    'mfa.ts',
    'services/dotActionAudit.ts',
    'services/dotActionQueue.ts',
    'services/reviewService.ts',
    'services/sentimentBackfill.ts',
    'lib/reviewFraud.ts',
    'lib/lgpd.ts',
    'routes/empresaRoutes.ts',
    'routes/adminTecnicoRoutes.ts',
  ];
  const ddl = /\b(ALTER\s+TABLE\s+reviews|CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?reviews|CREATE\s+(?:UNIQUE\s+)?INDEX\s+\w+\s+ON\s+reviews)\b/i;
  for (const file of files) {
    assert.equal(ddl.test(source(file)), false, `${file} não pode executar DDL em caminho de requisição`);
  }
});

test('adapter PostgreSQL não usa pool global mutável e expõe o lock de migração', () => {
  const src = source('lib/db.pg.ts');
  assert.equal(/^\s*let\s+pool\b/m.test(src), false, 'lib/db.pg.ts não pode ter pool global mutável');
  assert.match(src, /withMigrationLock/);
  assert.match(src, /pg_advisory_lock/);
  assert.match(src, /pg_advisory_unlock/);
  // Tolerância só é permitida para DDL com IF NOT EXISTS (corrida de catálogo).
  assert.match(src, /isIdempotentDdlRace/);
  assert.match(src, /IF\\s\+NOT\\s\+EXISTS/);
  assert.doesNotMatch(src, /if \(\s*\/already exists\/i\.test\(msg\)\s*\)\s*\{\s*continue;/);
});

test('requireReviewSchema falha explicitamente e não executa DDL', async () => {
  const { db, execCalls } = fakeDb({ reviews: ['id', 'created_at', 'is_test', 'ip_hash'] }, []);
  await assert.rejects(
    () => requireReviewSchema(db),
    (error: any) => /reviews\.(fraud_flags|origin|client_whatsapp|sentiment|locale)/.test(String(error?.message || error)),
  );
  assert.deepEqual(execCalls, [], 'verificação de reviews não pode executar DDL');
});

test('chave do advisory lock de migração é estável e positiva (int8)', () => {
  assert.equal(PG_MIGRATION_LOCK_KEY, 8005998760133593297n);
  assert.ok(PG_MIGRATION_LOCK_KEY > 0n);
  assert.ok(PG_MIGRATION_LOCK_KEY <= 9223372036854775807n, 'precisa caber em int8 assinado');
});
