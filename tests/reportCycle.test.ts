import { describe, expect, it } from 'vitest';
import { getCycleForDate } from '../lib/reportCycle.js';

describe('report cycles', () => {
  it('uses the plan activation anniversary instead of calendar month', () => {
    const c = getCycleForDate('2026-09-15T12:00:00Z', '2026-10-02T12:00:00Z');
    expect(c.start.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    expect(c.endInclusive.toISOString()).toBe('2026-10-14T23:59:59.999Z');
  });

  it('clamps a day-31 anchor to shorter months', () => {
    const c = getCycleForDate('2026-01-31T12:00:00Z', '2026-02-15T12:00:00Z');
    expect(c.start.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(c.endInclusive.toISOString()).toBe('2026-02-27T23:59:59.999Z');
  });

  it('starts the next cycle on the clamped anniversary', () => {
    const c = getCycleForDate('2026-01-31T12:00:00Z', '2026-03-01T12:00:00Z');
    expect(c.start.toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(c.endInclusive.toISOString()).toBe('2026-03-30T23:59:59.999Z');
  });

  it('handles a leap-year February anchor', () => {
    const c = getCycleForDate('2028-02-29T12:00:00Z', '2028-03-10T12:00:00Z');
    expect(c.start.toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(c.endInclusive.toISOString()).toBe('2028-03-28T23:59:59.999Z');
  });
});
