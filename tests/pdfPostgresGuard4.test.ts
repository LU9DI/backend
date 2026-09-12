import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('PDF generator has no SQLite date functions', () => {
  const source = readFileSync(new URL('../relatorioPdf.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('strftime('), false);
});
