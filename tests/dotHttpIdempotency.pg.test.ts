/**
 * Dot HTTP idempotency — PostgreSQL concurrency test.
 *
 * Uses a disposable database and independent pool connections through
 * Promise.all. The unique (empresa_id, idempotency_key) index must elect
 * exactly one winner even when claims arrive concurrently — never an in-memory
 * mutex.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { createTestDatabase, dropTestDatabase, databaseUrl } from './helpers/pg-test-utils.js';

let created: { name: string; url: string } | null = null;
let db: any;
let idempotency: typeof import('../services/dotHttpIdempotency.js');
const empresaId = `pg-dot-http-${crypto.randomUUID()}`;
const endpoint = '/api/dot/chat';

before(async () => {
  assert.ok(databaseUrl(), 'DATABASE_URL local de teste PostgreSQL é obrigatória');
  process.env.NODE_ENV = 'test';
  created = await createTestDatabase('filtra_dot_http_idempotency');
  process.env.DATABASE_URL = created.url;
  const { initDB, getDb } = await import('../lib/db.js');
  await initDB();
  db = getDb();
  idempotency = await import('../services/dotHttpIdempotency.js');
});

after(async () => {
  try {
    const { closeDB } = await import('../lib/db.js');
    await closeDB();
  } catch {
    /* best effort */
  }
  if (created) await dropTestDatabase(created.name);
});

test('PostgreSQL: migration creates the empresa/chave unique constraint', async () => {
  const table = await db.get(
    `SELECT 1 AS ok FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'dot_http_idempotency'`,
  );
  assert.ok(table, 'dot_http_idempotency table must exist after central migrations');

  const index = await db.get(
    `SELECT 1 AS ok FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'ux_dot_http_idempotency_empresa_key'`,
  );
  assert.ok(index, 'unique empresa/chave index must exist');
});

test('PostgreSQL: concurrent transactions claim a logical message exactly once', async () => {
  const input = {
    empresaId,
    endpoint,
    key: `pg-dot-key-${crypto.randomUUID()}`,
    payload: { message: 'Qual é a tendência atual?', session_id: 'pg-session' },
  };
  const results = await Promise.all(
    Array.from({ length: 12 }, () => idempotency.claimDotHttpRequest(input)),
  );
  assert.equal(results.filter((result) => result.kind === 'claimed').length, 1);
  assert.equal(results.filter((result) => result.kind === 'in_progress').length, 11);
});

test('PostgreSQL: completed response is replayed without changing status or body', async () => {
  const input = {
    empresaId,
    endpoint,
    key: `pg-dot-replay-${crypto.randomUUID()}`,
    payload: { message: 'Resuma os sinais', session_id: 'pg-session-replay' },
  };
  const claimed = await idempotency.claimDotHttpRequest(input);
  assert.equal(claimed.kind, 'claimed');
  if (claimed.kind !== 'claimed') return;

  const body = { ok: true, message: 'Os sinais permanecem estáveis.', provider: 'cache' };
  assert.equal(await idempotency.completeDotHttpRequest(claimed.claim, 200, body), true);
  const replay = await idempotency.claimDotHttpRequest(input);
  assert.equal(replay.kind, 'replay');
  if (replay.kind === 'replay') {
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, body);
  }
});

test('PostgreSQL: failed_safe retries once and then blocks the duplicate', async () => {
  const input = {
    empresaId,
    endpoint,
    key: `pg-dot-safe-${crypto.randomUUID()}`,
    payload: { message: 'Falha comprovada antes do envio', session_id: 'pg-session-safe' },
  };
  const first = await idempotency.claimDotHttpRequest(input);
  assert.equal(first.kind, 'claimed');
  if (first.kind !== 'claimed') return;
  await idempotency.markDotHttpRequestFailedSafe(first.claim);

  const retried = await idempotency.claimDotHttpRequest(input);
  assert.equal(retried.kind, 'claimed');
  assert.equal((await idempotency.claimDotHttpRequest(input)).kind, 'in_progress');
});
