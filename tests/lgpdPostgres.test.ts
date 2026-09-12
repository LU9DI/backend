import assert from 'assert';
import { ensureReviewTreatmentColumns, anonymizeOldClientWhatsapp } from '../lib/lgpd.js';

const previousUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = 'postgres://test:test@localhost/test';

const calls: string[] = [];
const rows = [
  { id: 10 },
  { id: 11 },
];

const db: any = {
  async all(sql: string, params?: any[]) {
    calls.push(`all:${sql}`);
    if (sql.includes('information_schema.columns')) {
      return [{ name: 'id' }, { name: 'client_whatsapp' }, { name: 'createdAt' }, { name: 'treated_at' }];
    }
    assert.match(sql, /SELECT id FROM reviews/);
    assert.ok(params?.length === 3);
    assert.doesNotMatch(sql, /datetime\s*\(|strftime\s*\(/i);
    return rows;
  },
  async exec(sql: string) {
    calls.push(`exec:${sql}`);
    assert.doesNotMatch(sql, /PRAGMA|datetime\s*\(|strftime\s*\(/i);
  },
  async run(sql: string, params?: any[]) {
    calls.push(`run:${sql}`);
    assert.ok(params?.length === 1);
    assert.match(sql, /UPDATE reviews SET client_whatsapp/);
    assert.doesNotMatch(sql, /datetime\s*\(|strftime\s*\(/i);
    return { changes: 1 };
  },
};

await ensureReviewTreatmentColumns(db);
const result = await anonymizeOldClientWhatsapp(db, { retentionDays: 90, limit: 2 });
assert.equal(result.anonymized, 2);
assert.ok(calls.some((x) => x.includes('information_schema.columns')));
assert.ok(!calls.some((x) => /PRAGMA|datetime\s*\(|strftime\s*\(/i.test(x)));

if (previousUrl === undefined) delete process.env.DATABASE_URL;
else process.env.DATABASE_URL = previousUrl;

console.log('ok lgpd postgres-safe');
