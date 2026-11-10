/**
 * Dot HTTP idempotency — contract tests on isolated SQLite.
 *
 * Covers the mandatory acceptance list from `docs/DOT_HTTP_IDEMPOTENCY.md`:
 * concurrent claim, replay, payload reuse, in-flight, stale/restart ambiguity,
 * failed_safe retry, multi-tenant isolation and the response-persistence
 * classifier. PostgreSQL multi-process behavior is covered by the `.pg.test.ts`
 * counterpart using the same unique index and transactional claim.
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

const tmpDb = path.join(
  os.tmpdir(),
  `filtra-dot-http-idempotency-${Date.now()}-${process.pid}.sqlite`,
);
process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = tmpDb;

const suite = sqliteAvailable ? describe : describe.skip;
const empresaId = 'empresa-dot-http-idempotency';
const otherEmpresaId = 'empresa-dot-http-idempotency-other';
const endpoint = '/api/dot/chat';

let db: any;
let idempotency: typeof import('../services/dotHttpIdempotency.js');

function fakeResponse() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, unknown>,
    sent: null as { status: number; body: unknown } | null,
    setHeader(name: string, value: unknown) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.sent = { status: this.statusCode, body };
      return this;
    },
  };
  return res;
}

function row(key: string, empresa = empresaId) {
  return db.get(
    'SELECT * FROM dot_http_idempotency WHERE empresa_id = ? AND endpoint = ? AND idempotency_key = ?',
    [empresa, endpoint, key],
  );
}

suite('Dot HTTP idempotency — claim, replay and ambiguity', () => {
  before(async () => {
    const { initDB, getDb } = await import('../lib/db.js');
    await initDB();
    db = getDb();
    idempotency = await import('../services/dotHttpIdempotency.js');
    await db.run('DELETE FROM dot_http_idempotency');
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

  test('migration creates the contract columns and unique scope index', async () => {
    const columns = (await db.all('PRAGMA table_info(dot_http_idempotency)')).map(
      (c: any) => String(c.name),
    );
    for (const required of [
      'empresa_id',
      'endpoint',
      'idempotency_key',
      'request_hash',
      'status',
      'response_status',
      'response_json',
      'created_at',
      'updated_at',
      'completed_at',
      'expires_at',
    ]) {
      assert.ok(columns.includes(required), `coluna obrigatória ausente: ${required}`);
    }
    assert.ok(!columns.includes('tenant_id'), 'não pode existir namespace legado tenant_id');

    const indexes = (await db.all('PRAGMA index_list(dot_http_idempotency)')).map(
      (i: any) => String(i.name),
    );
    assert.ok(
      indexes.includes('ux_dot_http_idempotency_empresa_key'),
      'índice único por empresa/chave ausente',
    );
  });

  test('claims a new key once and blocks a concurrent duplicate', async () => {
    const input = {
      empresaId,
      endpoint,
      key: 'dot-chat-key-concurrency-0001',
      payload: { message: 'Qual a tendência?', session_id: 'session-a' },
    };
    const first = await idempotency.claimDotHttpRequest(input);
    const second = await idempotency.claimDotHttpRequest(input);
    assert.equal(first.kind, 'claimed');
    assert.equal(second.kind, 'in_progress');

    const persisted = await row(input.key);
    assert.equal(persisted.status, 'processing');
    assert.equal(persisted.completed_at, null);
  });

  test('same key with a different payload is rejected without executing', async () => {
    const input = {
      empresaId,
      endpoint,
      key: 'dot-chat-key-mismatch-00001',
      payload: { message: 'Pergunta A', session_id: 'session-a' },
    };
    assert.equal((await idempotency.claimDotHttpRequest(input)).kind, 'claimed');
    assert.equal(
      (
        await idempotency.claimDotHttpRequest({
          ...input,
          payload: { message: 'Pergunta B', session_id: 'session-a' },
        })
      ).kind,
      'key_reused',
    );
  });

  test('canonical hash is independent of object key order', async () => {
    const a = idempotency.hashDotHttpPayload({ b: 2, a: { d: 4, c: 3 } });
    const b = idempotency.hashDotHttpPayload({ a: { c: 3, d: 4 }, b: 2 });
    assert.equal(a, b);
    const c = idempotency.hashDotHttpPayload({ a: { c: 3, d: 5 }, b: 2 });
    assert.notEqual(a, c);
  });

  test('completed request replays the exact stored status and JSON response', async () => {
    const input = {
      empresaId,
      endpoint,
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
      session_id: 'session-b',
      dot_tokens_used: 17,
    };
    assert.equal(await idempotency.completeDotHttpRequest(first.claim, 200, response), true);

    const replay = await idempotency.claimDotHttpRequest(input);
    assert.equal(replay.kind, 'replay');
    if (replay.kind === 'replay') {
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.body, response);
    }

    // A completed claim can no longer be overwritten by a late execution.
    assert.equal(await idempotency.completeDotHttpRequest(first.claim, 200, { ok: false }), false);
    const after = await row(input.key);
    assert.equal(after.status, 'completed');
    assert.deepEqual(JSON.parse(after.response_json), response);
  });

  test('stale processing requests become ambiguous and are never reclaimed', async () => {
    const input = {
      empresaId,
      endpoint,
      key: 'dot-chat-key-stale-00000001',
      payload: { message: 'Verifique o cenário', session_id: 'session-c' },
    };
    const first = await idempotency.claimDotHttpRequest(input);
    assert.equal(first.kind, 'claimed');
    await db.run(
      'UPDATE dot_http_idempotency SET updated_at = ? WHERE empresa_id = ? AND endpoint = ? AND idempotency_key = ?',
      [new Date(Date.now() - 20 * 60_000).toISOString(), empresaId, endpoint, input.key],
    );
    assert.equal((await idempotency.claimDotHttpRequest(input)).kind, 'ambiguous');
    assert.equal((await idempotency.claimDotHttpRequest(input)).kind, 'ambiguous');

    const persisted = await row(input.key);
    assert.equal(persisted.status, 'ambiguous');
  });

  test('concurrent claims have exactly one winner', async () => {
    const input = {
      empresaId,
      endpoint,
      key: 'dot-chat-key-race-000000001',
      payload: { message: 'Pergunta concorrente', session_id: 'session-race' },
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, () => idempotency.claimDotHttpRequest(input)),
    );
    assert.equal(results.filter((result) => result.kind === 'claimed').length, 1);
    assert.equal(results.filter((result) => result.kind === 'in_progress').length, 11);
  });

  test('explicit ambiguous provider outcomes remain blocked', async () => {
    const input = {
      empresaId,
      endpoint,
      key: 'dot-chat-key-ambiguous-0001',
      payload: { message: 'Pergunta incerta', session_id: 'session-d' },
    };
    const first = await idempotency.claimDotHttpRequest(input);
    assert.equal(first.kind, 'claimed');
    if (first.kind !== 'claimed') return;
    await idempotency.markDotHttpRequestAmbiguous(first.claim);
    assert.equal((await idempotency.claimDotHttpRequest(input)).kind, 'ambiguous');
  });

  test('failed_safe is retryable through a conditional transition; processing is not', async () => {
    const input = {
      empresaId,
      endpoint,
      key: 'dot-chat-key-failed-safe-001',
      payload: { message: 'Falha antes do envio', session_id: 'session-e' },
    };
    const first = await idempotency.claimDotHttpRequest(input);
    assert.equal(first.kind, 'claimed');
    if (first.kind !== 'claimed') return;
    await idempotency.markDotHttpRequestFailedSafe(first.claim);
    assert.equal((await row(input.key)).status, 'failed_safe');

    const retried = await idempotency.claimDotHttpRequest(input);
    assert.equal(retried.kind, 'claimed');
    if (retried.kind !== 'claimed') return;
    assert.equal((await row(input.key)).status, 'processing');
    assert.equal((await idempotency.claimDotHttpRequest(input)).kind, 'in_progress');
  });

  test('multi-tenant isolation: the same key in another empresa is independent', async () => {
    const input = {
      empresaId,
      endpoint,
      key: 'dot-chat-key-shared-0000001',
      payload: { message: 'Pergunta compartilhada', session_id: 'session-f' },
    };
    assert.equal((await idempotency.claimDotHttpRequest(input)).kind, 'claimed');
    const other = { ...input, empresaId: otherEmpresaId };
    const claimedOther = await idempotency.claimDotHttpRequest(other);
    assert.equal(claimedOther.kind, 'claimed');
    if (claimedOther.kind !== 'claimed') return;

    await idempotency.completeDotHttpRequest(claimedOther.claim, 200, { ok: true, tenant: 'other' });
    const replayOther = await idempotency.claimDotHttpRequest(other);
    assert.equal(replayOther.kind, 'replay');
    // The first tenant is still processing: no cross-tenant replay.
    assert.equal((await idempotency.claimDotHttpRequest(input)).kind, 'in_progress');
  });

  test('invalid keys are rejected before any database effect', async () => {
    for (const key of ['', 'short', 'x'.repeat(129), 'invalid key with space']) {
      await assert.rejects(() =>
        idempotency.claimDotHttpRequest({
          empresaId,
          endpoint,
          key,
          payload: { message: 'x', session_id: 'y' },
        }),
      );
    }
    assert.equal(await db.get('SELECT COUNT(*) AS c FROM dot_http_idempotency WHERE idempotency_key = ?', ['short']).then((r: any) => Number(r.c)), 0);
  });

  test('retention purges only expired completed rows', async () => {
    const doneInput = {
      empresaId,
      endpoint,
      key: 'dot-chat-key-expired-000001',
      payload: { message: 'Concluída', session_id: 'session-g' },
    };
    const done = await idempotency.claimDotHttpRequest(doneInput);
    assert.equal(done.kind, 'claimed');
    if (done.kind !== 'claimed') return;
    await idempotency.completeDotHttpRequest(done.claim, 200, { ok: true });
    await db.run(
      'UPDATE dot_http_idempotency SET expires_at = ? WHERE empresa_id = ? AND idempotency_key = ?',
      [new Date(Date.now() - 60_000).toISOString(), empresaId, doneInput.key],
    );

    const pendingInput = {
      empresaId,
      endpoint,
      key: 'dot-chat-key-pending-expired-1',
      payload: { message: 'Em curso', session_id: 'session-h' },
    };
    const pending = await idempotency.claimDotHttpRequest(pendingInput);
    assert.equal(pending.kind, 'claimed');
    await db.run(
      'UPDATE dot_http_idempotency SET expires_at = ? WHERE empresa_id = ? AND idempotency_key = ?',
      [new Date(Date.now() - 60_000).toISOString(), empresaId, pendingInput.key],
    );

    // Any new claim triggers the purge of expired completed rows only.
    await idempotency.claimDotHttpRequest({
      empresaId,
      endpoint,
      key: 'dot-chat-key-purge-trigger-001',
      payload: { message: 'gatilho', session_id: 'session-i' },
    });
    assert.equal(await row(doneInput.key), undefined, 'linha completed expirada deve ser purgada');
    assert.ok(await row(pendingInput.key), 'linha processing NUNCA pode ser purgada');
  });

  test('response wrapper: 2xx completes, 5xx classifies conservatively', async () => {
    const okInput = {
      empresaId,
      endpoint,
      key: 'dot-chat-key-wrapper-ok-0001',
      payload: { message: 'wrapper ok', session_id: 'session-j' },
    };
    const ok = await idempotency.claimDotHttpRequest(okInput);
    assert.equal(ok.kind, 'claimed');
    if (ok.kind !== 'claimed') return;
    const okRes = fakeResponse();
    okRes.statusCode = 200;
    idempotency.persistDotHttpResponse(okRes, ok.claim, { providerAttempted: true });
    await okRes.json({ ok: true, message: 'resposta' });
    assert.equal((await row(okInput.key)).status, 'completed');
    assert.deepEqual(okRes.sent, { status: 200, body: { ok: true, message: 'resposta' } });

    const ambiguousInput = {
      empresaId,
      endpoint,
      key: 'dot-chat-key-wrapper-500-001',
      payload: { message: 'wrapper 500', session_id: 'session-k' },
    };
    const ambiguous = await idempotency.claimDotHttpRequest(ambiguousInput);
    assert.equal(ambiguous.kind, 'claimed');
    if (ambiguous.kind !== 'claimed') return;
    const errRes = fakeResponse();
    errRes.statusCode = 503;
    idempotency.persistDotHttpResponse(errRes, ambiguous.claim, { providerAttempted: true });
    await errRes.json({ ok: false, error: 'provider' });
    assert.equal((await row(ambiguousInput.key)).status, 'ambiguous');

    const safeInput = {
      empresaId,
      endpoint,
      key: 'dot-chat-key-wrapper-500-002',
      payload: { message: 'wrapper 500 safe', session_id: 'session-l' },
    };
    const safe = await idempotency.claimDotHttpRequest(safeInput);
    assert.equal(safe.kind, 'claimed');
    if (safe.kind !== 'claimed') return;
    const safeRes = fakeResponse();
    safeRes.statusCode = 503;
    idempotency.persistDotHttpResponse(safeRes, safe.claim, { providerAttempted: false });
    await safeRes.json({ ok: false, error: 'budget unavailable' });
    assert.equal((await row(safeInput.key)).status, 'failed_safe');
    assert.equal((await idempotency.claimDotHttpRequest(safeInput)).kind, 'claimed');

    const limitInput = {
      empresaId,
      endpoint,
      key: 'dot-chat-key-wrapper-429-001',
      payload: { message: 'wrapper 429', session_id: 'session-m' },
    };
    const limit = await idempotency.claimDotHttpRequest(limitInput);
    assert.equal(limit.kind, 'claimed');
    if (limit.kind !== 'claimed') return;
    const limitRes = fakeResponse();
    limitRes.statusCode = 429;
    idempotency.persistDotHttpResponse(limitRes, limit.claim, { providerAttempted: false });
    await limitRes.json({ ok: false, code: 'DOT_TOKEN_LIMIT' });
    assert.equal((await row(limitInput.key)).status, 'failed_safe');
  });

  test('a lost claim refuses to send success and marks the request ambiguous', async () => {
    const input = {
      empresaId,
      endpoint,
      key: 'dot-chat-key-lost-claim-00001',
      payload: { message: 'claim perdido', session_id: 'session-n' },
    };
    const claimed = await idempotency.claimDotHttpRequest(input);
    assert.equal(claimed.kind, 'claimed');
    if (claimed.kind !== 'claimed') return;

    // Simulate another process promoting the claim to ambiguous (stale lease).
    await idempotency.markDotHttpRequestAmbiguous(claimed.claim);

    const res = fakeResponse();
    res.statusCode = 200;
    idempotency.persistDotHttpResponse(res, claimed.claim, { providerAttempted: true });
    await res.json({ ok: true, message: 'não deveria sair' });

    assert.equal(res.sent?.status, 503);
    assert.equal((res.sent?.body as any).code, 'DOT_IDEMPOTENCY_PERSIST_FAILED');
    assert.equal((await row(input.key)).status, 'ambiguous');
  });
});
