import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countPendingSentOverGrace } from '../lib/dotLedgerMetrics.js';

test('conta reservas pending enviadas além da carência, inclusive as já marcadas ambíguas', async () => {
  const now = Date.parse('2026-11-13T12:00:00.000Z');
  let query = '';
  let params: unknown[] = [];
  const db = {
    async get(sql: string, values?: unknown[]) {
      query = sql;
      params = values || [];
      return { c: '4' };
    },
  };

  const count = await countPendingSentOverGrace(db, now, 10 * 60_000);

  assert.equal(count, 4);
  assert.match(query, /status = 'pending'/);
  assert.doesNotMatch(query, /ambiguous = 0/);
  assert.match(query, /sent_at IS NOT NULL/);
  assert.deepEqual(params, [
    '2026-11-13T12:00:00.000Z',
    '2026-11-13T11:50:00.000Z',
  ]);
});

test('não altera reservas e retorna null quando a consulta falha', async () => {
  let calls = 0;
  const db = {
    async get() {
      calls += 1;
      throw new Error('database unavailable');
    },
  };

  const count = await countPendingSentOverGrace(db, Date.parse('2026-11-13T12:00:00.000Z'), 600_000);

  assert.equal(count, null);
  assert.equal(calls, 1);
});

test('retorna null para resultado inválido em vez de fabricar zero', async () => {
  const db = { async get() { return { c: 'not-a-number' }; } };
  assert.equal(
    await countPendingSentOverGrace(db, Date.parse('2026-11-13T12:00:00.000Z'), 600_000),
    null,
  );
});


test('consulta SQLite conta reservas pendentes ambíguas e exclui registros fora da janela', async (t) => {
  let sqlite3: any;
  let open: any;
  try {
    sqlite3 = (await import('sqlite3')).default;
    open = (await import('sqlite')).open;
  } catch {
    t.skip('driver SQLite indisponível neste ambiente');
    return;
  }

  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  try {
    await db.exec(`
      CREATE TABLE dot_budget_reservations (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        ambiguous INTEGER NOT NULL DEFAULT 0,
        sent_at TEXT,
        expires_at TEXT NOT NULL
      )
    `);
    await db.run(
      'INSERT INTO dot_budget_reservations (status, ambiguous, sent_at, expires_at) VALUES (?, ?, ?, ?)',
      ['pending', 1, '2026-11-13T11:40:00.000Z', '2026-11-13T11:30:00.000Z'],
    );
    await db.run(
      'INSERT INTO dot_budget_reservations (status, ambiguous, sent_at, expires_at) VALUES (?, ?, ?, ?)',
      ['pending', 0, '2026-11-13T11:55:00.000Z', '2026-11-13T11:30:00.000Z'],
    );
    await db.run(
      'INSERT INTO dot_budget_reservations (status, ambiguous, sent_at, expires_at) VALUES (?, ?, ?, ?)',
      ['pending', 0, null, '2026-11-13T11:30:00.000Z'],
    );
    await db.run(
      'INSERT INTO dot_budget_reservations (status, ambiguous, sent_at, expires_at) VALUES (?, ?, ?, ?)',
      ['settled', 1, '2026-11-13T11:40:00.000Z', '2026-11-13T11:30:00.000Z'],
    );
    await db.run(
      'INSERT INTO dot_budget_reservations (status, ambiguous, sent_at, expires_at) VALUES (?, ?, ?, ?)',
      ['pending', 0, '2026-11-13T11:40:00.000Z', '2026-11-13T12:30:00.000Z'],
    );

    const count = await countPendingSentOverGrace(
      db,
      Date.parse('2026-11-13T12:00:00.000Z'),
      10 * 60_000,
    );
    assert.equal(count, 1);
  } finally {
    await db.close();
  }
});
