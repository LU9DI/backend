import { describe, expect, it } from 'vitest';
import { getCycleForDate } from '../lib/reportCycle.js';

describe('monthly report cycle boundaries', () => {
  it('handles day 31 clamped to February', () => {
    const c = getCycleForDate('2026-01-31T12:00:00Z', '2026-02-15T12:00:00Z');
    expect(c.start.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(c.endInclusive.toISOString()).toBe('2026-02-27T23:59:59.999Z');
  });
});
