import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueRetry, processRetryQueue, registerRetryHandler } from '../lib/retryQueue.js';

describe('retry queue database compatibility', () => {
  it('uses INSERT RETURNING instead of sqlite-only lastID', async () => {
    const statements: string[] = [];
    const db: any = {
      async exec(sql: string) {
        statements.push(sql);
      },
      async get(sql: string, _params?: any[]) {
        statements.push(sql);
        if (/INSERT INTO retry_queue/i.test(sql)) return { id: 42 };
        return undefined;
      },
      async run() {
        throw new Error('run() should not be used to obtain the inserted retry id');
      },
      async all() {
        return [];
      },
    };

    const id = await enqueueRetry(
      {
        jobType: 'followup_email',
        payload: { followup_id: 'followup-test' },
        dedupeKey: 'followup_email:followup-test',
      },
      db
    );

    assert.equal(id, 42);
    assert.ok(statements.some((sql) => /RETURNING id/i.test(sql)));
  });
});


describe('retry queue atomic claiming', () => {
  it('does not execute a job when another worker already claimed it', async () => {
    let handlerCalls = 0;
    const db: any = {
      async exec() {},
      async get() { return undefined; },
      async all() {
        return [{
          id: 7,
          job_type: 'claim-race-test',
          payload: JSON.stringify({ ok: true }),
          attempts: 0,
          max_attempts: 3,
          next_run_at: new Date().toISOString(),
          status: 'pending',
        }];
      },
      async run(sql: string) {
        if (/SET status = 'processing'/i.test(sql)) return { changes: 0 };
        return { changes: 0 };
      },
    };

    registerRetryHandler('claim-race-test', async () => {
      handlerCalls++;
    });

    const result = await processRetryQueue(db, 1);

    assert.equal(result.processed, 1);
    assert.equal(result.ok, 0);
    assert.equal(handlerCalls, 0);
  });

  it('executes only after successfully claiming the job', async () => {
    let handlerCalls = 0;
    const db: any = {
      async exec() {},
      async get() { return undefined; },
      async all() {
        return [{
          id: 8,
          job_type: 'claim-success-test',
          payload: JSON.stringify({ ok: true }),
          attempts: 0,
          max_attempts: 3,
          next_run_at: new Date().toISOString(),
          status: 'pending',
        }];
      },
      async run(sql: string) {
        if (/SET status = 'processing'/i.test(sql)) return { changes: 1 };
        return { changes: 1 };
      },
    };

    registerRetryHandler('claim-success-test', async () => {
      handlerCalls++;
    });

    const result = await processRetryQueue(db, 1);

    assert.equal(result.ok, 1);
    assert.equal(handlerCalls, 1);
  });
});
