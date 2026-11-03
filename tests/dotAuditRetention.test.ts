import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = path.join(os.tmpdir(), `filtra-dot-audit-retention-${Date.now()}.sqlite`);
delete process.env.DATABASE_URL;

import { closeDB, getDb, initDB } from '../lib/db.js';
import { ensureDotAccessSchema } from '../services/dotAccessControl.js';
import {
  exportExpiredDotAudit,
  planDotAuditRetention,
  purgeExpiredDotAudit,
  retentionCutoff,
} from '../services/dotAuditRetention.js';

const old = new Date(Date.now() - 500 * 86_400_000).toISOString();
const recent = new Date().toISOString();

test('retenção: plano é dry-run e limite é calculado por dias', async () => {
  await initDB();
  await ensureDotAccessSchema();
  const db = getDb();
  await db.run(
    `INSERT INTO dot_action_audit (empresa_id,action_id,decision_id,event,actor_type,actor_id,metadata,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    ['emp-ret', 1, 1, 'prepared', 'dot', null, null, old],
  );
  await db.run(
    `INSERT INTO dot_action_audit (empresa_id,action_id,decision_id,event,actor_type,actor_id,metadata,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    ['emp-ret', 2, 2, 'prepared', 'user', 'u1', null, recent],
  );

  assert.equal(retentionCutoff(365).length > 0, true);
  const plan = await planDotAuditRetention(db);
  const action = plan.find((row) => row.table === 'dot_action_audit');
  assert.ok(action);
  assert.equal(action!.expired, 1, 'apenas a linha antiga deve aparecer no plano');
  assert.equal(action!.retention_days, 365);

  // Plano/export não apagam.
  await exportExpiredDotAudit(db);
  const count = await db.get('SELECT COUNT(*) AS c FROM dot_action_audit');
  assert.equal(Number(count.c), 2);
});

test('retenção: purge exige confirmação e remove somente expirados', async () => {
  await initDB();
  const db = getDb();
  await assert.rejects(
    () => purgeExpiredDotAudit(db, { confirm: false }),
    /confirmação explícita/i,
  );

  const results = await purgeExpiredDotAudit(db, { confirm: true });
  const action = results.find((row) => row.table === 'dot_action_audit');
  assert.ok(action);
  assert.equal(action!.deleted, 1);

  const rows = await db.all('SELECT action_id FROM dot_action_audit ORDER BY action_id');
  assert.deepEqual(rows.map((row: any) => Number(row.action_id)), [2], 'linha recente deve permanecer');
});

test('limpeza', async () => {
  await closeDB();
  try {
    fs.rmSync(process.env.SQLITE_DB_PATH!, { force: true });
  } catch {
    /* best effort */
  }
});
