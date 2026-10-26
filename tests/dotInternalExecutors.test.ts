import assert from 'node:assert/strict';
import { test } from 'node:test';

let sqliteAvailable = true;
try {
  await import('sqlite3');
  await import('sqlite');
} catch {
  sqliteAvailable = false;
}

const executorTest = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !sqliteAvailable }, fn);

import { initDB, getDb } from '../lib/db.js';
import { executeDotInternalAction } from '../services/dotInternalExecutors.js';

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = '/tmp/filtra-dot-internal-executors-test.sqlite';

let ready = false;

async function setup() {
  if (ready) return;
  await initDB();
  const db = getDb();
  // The service owns this table's schema; initialize it through the public
  // operation before cleanup so the test does not assume a prior app startup.
  await executeDotInternalAction({
    empresaId: '__schema_init__',
    actionId: 0,
    decisionId: 0,
    action: '__schema_init__',
    reason: 'Initialize test schema',
  });
  await db.run('DELETE FROM dot_internal_cases');
  ready = true;
}

executorTest('DOT internal executor creates a real tenant-scoped operational case', async () => {
  await setup();
  const empresaId = 'dot-executor-company';
  const result = await executeDotInternalAction({
    empresaId,
    actionId: 91001,
    decisionId: 81001,
    action: 'priorizar_e_resolver',
    eventId: 71001,
    priority: 'alta',
    reason: 'Avaliação crítica recorrente.',
  });

  assert.equal(result.created, true);
  assert.equal(result.status, 'prioritized');
  assert.ok(result.caseId > 0);

  const row = await getDb().get(
    'SELECT empresa_id,action_id,decision_id,event_id,status,priority FROM dot_internal_cases WHERE id=? AND empresa_id=?',
    [result.caseId, empresaId],
  );
  assert.equal(row?.empresa_id, empresaId);
  assert.equal(Number(row?.action_id), 91001);
  assert.equal(Number(row?.decision_id), 81001);
  assert.equal(Number(row?.event_id), 71001);
  assert.equal(row?.status, 'prioritized');
  assert.equal(row?.priority, 'alta');
});

executorTest('DOT internal executor is replay-safe for the same action', async () => {
  await setup();
  const input = {
    empresaId: 'dot-replay-company',
    actionId: 92001,
    decisionId: 82001,
    action: 'escalar_responsavel',
    priority: 'media',
    reason: 'Escalonamento interno.',
  } as const;

  const first = await executeDotInternalAction(input);
  const second = await executeDotInternalAction(input);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.caseId, second.caseId);
});
