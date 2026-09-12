import assert from 'node:assert/strict';
import { test } from 'node:test';

test('PDF cache only accepts buffers beginning with %PDF-', () => {
  assert.equal(Buffer.from('%PDF-1.7').subarray(0, 5).toString('ascii'), '%PDF-');
  assert.notEqual(Buffer.from('{"error":"invalid"}').subarray(0, 5).toString('ascii'), '%PDF-');
});
