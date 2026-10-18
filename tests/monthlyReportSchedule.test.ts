import test from 'node:test';
import assert from 'node:assert/strict';
import { hasUnresolvedMonthlyReport, subscriptionReportDue } from '../routes/monthlyReportJobsRoutes.js';

test('monthly report runs on the subscription anniversary day', () => {
  assert.equal(subscriptionReportDue(18, new Date('2026-10-18T12:00:00.000Z')), true);
  assert.equal(subscriptionReportDue(18, new Date('2026-10-17T12:00:00.000Z')), false);
});

test('anniversary on days 29-31 falls back to the last day of shorter months', () => {
  assert.equal(subscriptionReportDue(31, new Date('2026-02-28T12:00:00.000Z')), true);
  assert.equal(subscriptionReportDue(31, new Date('2026-02-27T12:00:00.000Z')), false);
  assert.equal(subscriptionReportDue(31, new Date('2026-03-31T12:00:00.000Z')), true);
  assert.equal(subscriptionReportDue(29, new Date('2026-02-28T12:00:00.000Z')), true);
  assert.equal(subscriptionReportDue(29, new Date('2026-02-27T12:00:00.000Z')), false);
  assert.equal(subscriptionReportDue(30, new Date('2026-02-28T12:00:00.000Z')), true);
  assert.equal(subscriptionReportDue(30, new Date('2026-02-27T12:00:00.000Z')), false);
  // Ano bissexto: fevereiro tem 29 dias e o dia 31 cai nele.
  assert.equal(subscriptionReportDue(31, new Date('2028-02-29T12:00:00.000Z')), true);
  assert.equal(subscriptionReportDue(31, new Date('2028-02-28T12:00:00.000Z')), false);
});

test('invalid subscription days never trigger scheduled reports', () => {
  const now = new Date('2026-10-18T12:00:00.000Z');
  for (const day of [null, undefined, 0, -1, 32, 'invalid']) {
    assert.equal(subscriptionReportDue(day, now), false);
  }
});

test('unresolved monthly report reservations retry after the anniversary day', () => {
  const now = new Date('2026-10-22T12:00:00.000Z');
  assert.equal(hasUnresolvedMonthlyReport('failed', null, '2026-10-18T12:00:00.000Z', now), true);
  assert.equal(hasUnresolvedMonthlyReport('accepted', null, '2026-10-18T12:00:00.000Z', now), true);
  assert.equal(hasUnresolvedMonthlyReport('accepted', '{"ok":true}', '2026-10-18T12:00:00.000Z', now), false);
});

test('generated snapshot counts as resolved when external delivery is disabled', () => {
  const now = new Date('2026-10-22T12:00:00.000Z');
  assert.equal(hasUnresolvedMonthlyReport('generated', '{"ok":true}', '2026-10-18T12:00:00.000Z', now), false);
  assert.equal(hasUnresolvedMonthlyReport('generated', '{"ok":true}', '2026-10-18T12:00:00.000Z', now, true), true);
  assert.equal(hasUnresolvedMonthlyReport('generated', null, '2026-10-18T12:00:00.000Z', now), true);
});

test('processing reservation is retried only after the 30-minute lease expires', () => {
  const now = new Date('2026-10-18T12:45:00.000Z');
  assert.equal(hasUnresolvedMonthlyReport('processing', null, '2026-10-18T12:20:00.000Z', now), false);
  assert.equal(hasUnresolvedMonthlyReport('processing', null, '2026-10-18T12:10:00.000Z', now), true);
  assert.equal(hasUnresolvedMonthlyReport('pending', null, '2026-10-18T12:00:00.000Z', now), false);
});
