import assert from 'node:assert/strict';
import { enqueueRetry } from '../lib/retryQueue.js';

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
