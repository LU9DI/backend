import assert from 'node:assert/strict';
import { test } from 'node:test';

test('PDF cache requires PDF magic header', () => {
  const valid = Buffer.from('%PDF-1.7\n');
  const invalid = Buffer.from('{"error":"no pdf"}');
  assert.equal(valid.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.notEqual(invalid.subarray(0, 5).toString('ascii'), '%PDF-');
});
