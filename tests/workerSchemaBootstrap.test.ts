import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureRetryQueue } from '../lib/retryQueue.js';
import { ensureAcquisitionEngineSchema } from '../lib/acquisitionEngine.js';

describe('worker schema bootstrap caching', () => {
  it('runs retry queue DDL once per database handle, including concurrent callers', async () => {
    const statements: string[] = [];
    const db: any = {
      async exec(sql: string) { statements.push(sql); },
    };

    await Promise.all([
      ensureRetryQueue(db),
      ensureRetryQueue(db),
      ensureRetryQueue(db),
    ]);
    const afterFirstBootstrap = statements.length;

    await ensureRetryQueue(db);

    assert.ok(afterFirstBootstrap > 0);
    assert.equal(statements.length, afterFirstBootstrap);
  });

  it('runs acquisition DDL once per database handle, including concurrent callers', async () => {
    const statements: string[] = [];
    const db: any = {
      async exec(sql: string) { statements.push(sql); },
    };

    await Promise.all([
      ensureAcquisitionEngineSchema(db),
      ensureAcquisitionEngineSchema(db),
      ensureAcquisitionEngineSchema(db),
    ]);
    const afterFirstBootstrap = statements.length;

    await ensureAcquisitionEngineSchema(db);

    assert.ok(afterFirstBootstrap > 0);
    assert.equal(statements.length, afterFirstBootstrap);
  });

  it('retries schema bootstrap after a transient setup failure', async () => {
    let calls = 0;
    const db: any = {
      async exec() {
        calls += 1;
        if (calls === 1) throw new Error('temporary database interruption');
      },
    };

    await assert.rejects(() => ensureRetryQueue(db), /temporary database interruption/);
    await ensureRetryQueue(db);
    assert.ok(calls > 2);
  });
});
