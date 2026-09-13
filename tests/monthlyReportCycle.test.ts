import assert from 'node:assert/strict';
import test from 'node:test';
import { cycleEnded, getCycleForDate } from '../lib/reportCycle.js';

test('cycle uses the purchase day instead of calendar month', () => {
  const cycle = getCycleForDate('2026-09-15T12:00:00.000Z', '2026-10-10T12:00:00.000Z');

  assert.equal(cycle.start.toISOString(), '2026-09-15T00:00:00.000Z');
  assert.equal(cycle.endExclusive.toISOString(), '2026-10-15T00:00:00.000Z');
  assert.equal(cycle.endInclusive.toISOString(), '2026-10-14T23:59:59.999Z');
  assert.equal(cycle.key, '2026-09-15_2026-10-14');
});

test('next cycle starts on the same billing day', () => {
  const cycle = getCycleForDate('2026-09-15T12:00:00.000Z', '2026-10-15T12:00:00.000Z');

  assert.equal(cycle.start.toISOString(), '2026-10-15T00:00:00.000Z');
  assert.equal(cycle.endExclusive.toISOString(), '2026-11-15T00:00:00.000Z');
  assert.equal(cycle.key, '2026-10-15_2026-11-14');
});

test('closed cycle is only considered finished after endExclusive', () => {
  const cycle = getCycleForDate('2026-09-15T12:00:00.000Z', '2026-10-10T12:00:00.000Z');

  assert.equal(cycleEnded(cycle, new Date('2026-10-14T23:59:59.999Z')), false);
  assert.equal(cycleEnded(cycle, new Date('2026-10-15T00:00:00.000Z')), true);
});

test('end-of-month anchors clamp safely', () => {
  const cycle = getCycleForDate('2026-01-31T12:00:00.000Z', '2026-02-15T12:00:00.000Z');

  assert.equal(cycle.start.toISOString(), '2026-01-31T00:00:00.000Z');
  assert.equal(cycle.endExclusive.toISOString(), '2026-02-28T00:00:00.000Z');
  assert.equal(cycle.endInclusive.toISOString(), '2026-02-27T23:59:59.999Z');
});
