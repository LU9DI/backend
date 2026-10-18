import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { invalidateCompanyReviewsCache, loadCompanyReviewsCached } from '../services/companyReviewsCache.js';

describe('company reviews shared cache', () => {
  it('reuses the complete review set for panel and report consumers', async () => {
    let calls = 0;
    const rows = [
      { id: 'review-new', createdAt: '2026-10-01T12:00:00.000Z', rating: 5 },
      { id: 'review-old', createdAt: '2026-09-01T12:00:00.000Z', rating: 2 },
    ];
    const db = { all: async () => { calls++; return rows; } };
    const panelSource = await loadCompanyReviewsCached(db, 'cache-test-company');
    const reportSource = await loadCompanyReviewsCached(db, 'cache-test-company');
    assert.equal(calls, 1);
    assert.equal(panelSource.length, 2);
    assert.strictEqual(reportSource, panelSource);
    assert.equal(reportSource.some((row) => row.id === 'review-old'), true);
    invalidateCompanyReviewsCache('cache-test-company');
  });

  it('does not repopulate stale cache when invalidated during an in-flight query', async () => {
    let releaseOld!: (rows: any[]) => void;
    let calls = 0;
    const db = {
      all: async () => {
        calls++;
        if (calls === 1) return await new Promise<any[]>((resolve) => { releaseOld = resolve; });
        return [{ id: 'fresh-after-invalidation' }];
      },
    };
    const company = 'cache-invalidation-race';
    const oldLoad = loadCompanyReviewsCached(db, company);
    invalidateCompanyReviewsCache(company);
    const fresh = await loadCompanyReviewsCached(db, company);
    releaseOld([{ id: 'stale-before-invalidation' }]);
    await oldLoad;
    const subsequent = await loadCompanyReviewsCached(db, company);
    assert.equal(fresh[0].id, 'fresh-after-invalidation');
    assert.equal(subsequent[0].id, 'fresh-after-invalidation');
    assert.equal(calls, 2);
    invalidateCompanyReviewsCache(company);
  });

  it('does not share cached rows between distinct database connections', async () => {
    const first = { all: async () => [{ id: 'first-db' }] };
    const second = { all: async () => [{ id: 'second-db' }] };
    const suffix = String(Date.now());
    const a = await loadCompanyReviewsCached(first, suffix);
    const b = await loadCompanyReviewsCached(second, suffix);
    assert.equal(a[0].id, 'first-db');
    assert.equal(b[0].id, 'second-db');
    invalidateCompanyReviewsCache(suffix);
  });
});
