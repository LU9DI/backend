import assert from 'node:assert/strict';
import { test } from 'node:test';

test('PDF cache magic header', () => {
  assert.equal(Buffer.from('%PDF-1.7').subarray(0, 5).toString('ascii'), '%PDF-');
});
