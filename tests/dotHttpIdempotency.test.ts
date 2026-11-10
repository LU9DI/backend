/**
 * HTTP idempotency for the Filtra Dot chat endpoint.
 * Uses an isolated SQLite database; PostgreSQL multi-process behavior is
 * covered by the same unique constraint + transactional claim in production.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

let sqliteAvailable = true;
try {
  await import('sqlite3');
  await import('sqlite');
} catch {
  sqliteAvailable = false;
}

const tmpDb = path.join(os.tmpdir(), `filtra-dot-http-idempotency-${Date.now()}-${process.pid}.sqlite`);
process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = tmpDb;

const suite = sqliteAvailable ? describe : describe.skip;
const tenantId = 'empresa-dot-http-idempotency';

let db: any;
let idempotency: typeof import('../services/dotHttpIdempotency.js');

suite('Dot HTTP idempotency — claim, replay and ambiguity', () => {
  before(async () => {
    const { initDB, getDb } = await import('../lib/db.js');
    await initDB();
    db = getDb();
    idempotency = await import('../services/dotHttpIdempotency.js');
    await db.run('DELETE FROM dot_http_idempotency WHERE tenant_id = ?', [tenantId]);
  });

  after(async () => {
    try {
      const { closeDB } = await import('../lib/db.js');
      await closeDB();
    } catch {
      /* best effort */
    }
    try {
      fs.unlinkSync(tmpDb);
    } catch {
      /* best effort */
    }
  });

  test('claims a new key once and blocks a concurrent duplicate', async () => {
    const input = {
      tenantId,
      endpoint: '/api/dot/chat',
      key: 'dot-chat-key-concurrency-0001',
      payload: { message: 'Qual a tendência?', session_id: 'session-a' },
    };
    const first = await idempotency.claimDotHttpRequest(input);
    const second = await idempotency.claimDotHttpRequest(input);
    assert.equal(first.kind, 'claimed');
    assert.equal(second.kind, 'in_progress');
  });

  test('same key with a different payload is rejected', async () => {
    const input = {
      tenantId,
      endpoint: '/api/dot/chat',
      key: 'dot-chat-key-mismatch-00001',
      payload: { message: 'Pergunta A', session_id: 'session-a' },
    };
    assert.equal((await idempotency.claimDotHttpRequest(input)).kind, 'claimed');
    assert.equal((await idempotency.claimDotHttpRequest({
      ...input,
      payload: { message: 'Pergunta B', session_id: 'session-a' },
    })).kind, 'payload_mismatch');
  });

  test('completed request replays the exact stored status and JSON response', async () => {
    const input = {
      tenantId,
      endpoint: '/api/dot/chat',
      key: 'dot-chat-key-replay-0000001',
      payload: { message: 'Resumo', session_id: 'session-b' },
    };
    const first = await idempotency.claimDotHttpRequest(input);
    assert.equal(first.kind, 'claimed');
    if (first.kind !== 'claimed') return;

    const response = {
      ok: true,
      message: 'A nota média ficou estável.',
      provider: 'cache',
      tokens_used: 0,
    };
    assert.equal(await idempotency.completeDotHttpRequest(first.claim, 200, response), true);
    const replay = await idempotency.claimDotHttpRequest(input);
    assert.equal(replay.kind, 'replay');
    if (replay.kind === 'replay') {
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.body, response);
    }
  });

  test('stale pending requests become ambiguous and are never reclaimed', async () => {
    const input = {
      tenantId,
      endpoint: '/api/dot/chat',
      key: 'dot-chat-key-stale-00000001',
      payload: { message: 'Verifique o cenário', session_id: 'session-c' },
    };
    const first = await idempotency.claimDotHttpRequest(input);
    assert.equal(first.kind, 'claimed');
    await db.run(
      'UPDATE dot_http_idempotency SET updated_at = ? WHERE tenant_id = ? AND endpoint = ? AND idempotency_key = ?',
      [new Date(Date.now() - 20 * 60_000).toISOString(), tenantId, input.endpoint, input.key],
    );
    assert.equal((await idempotency.claimDotHttpRequest(input)).kind, 'ambiguous');
    assert.equal((await idempotency.claimDotHttpRequest(input)).kind, 'ambiguous');
  });

  test('concurrent claims have exactly one winner', async () => {
    const input = {
      tenantId,
      endpoint: '/api/dot/chat',
      key: 'dot-chat-key-race-000000001',
      payload: { message: 'Pergunta concorrente', session_id: 'session-race' },
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => idempotency.claimDotHttpRequest(input)),
    );
    assert.equal(results.filter((result) => result.kind === 'claimed').length, 1);
    assert.equal(results.filter((result) => result.kind === 'in_progress').length, 7);
  });

  test('ambiguous provider outcomes remain blocked', async () => {
    const input = {
      tenantId,
      endpoint: '/api/dot/chat',
      key: 'dot-chat-key-ambiguous-0001',
      payload: { message: 'Pergunta incerta', session_id: 'session-d' },
    };
    const first = await idempotency.claimDotHttpRequest(input);
    assert.equal(first.kind, 'claimed');
    if (first.kind !== 'claimed') return;
    await idempotency.markDotHttpRequestAmbiguous(first.claim);
    assert.equal((await idempotency.claimDotHttpRequest(input)).kind, 'ambiguous');
  });
});
