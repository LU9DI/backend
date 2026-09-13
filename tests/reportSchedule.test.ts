import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextMonthAfterDue,
  previousMonthSameDay,
  dateOnly,
} from '../lib/reportSchedule.js';
import { reportIdempotencyKey } from '../lib/n8n.js';

test('dia 12 → próximo mês dia 12', () => {
  const next = nextMonthAfterDue('2026-09-12T18:00:00.000Z');
  assert.equal(dateOnly(next), '2026-10-12');
});

test('31/01 → último dia de fevereiro (não bissexto)', () => {
  const next = nextMonthAfterDue('2026-01-31T12:00:00.000Z');
  assert.equal(dateOnly(next), '2026-02-28');
});

test('31/01 → 29/02 em ano bissexto', () => {
  const next = nextMonthAfterDue('2024-01-31T12:00:00.000Z');
  assert.equal(dateOnly(next), '2024-02-29');
});

test('31/03 → 30/04', () => {
  const next = nextMonthAfterDue('2026-03-31T12:00:00.000Z');
  assert.equal(dateOnly(next), '2026-04-30');
});

test('previousMonthSameDay de 12/10 → 12/09', () => {
  assert.equal(previousMonthSameDay('2026-10-12T15:00:00.000Z'), '2026-09-12');
});

test('idempotency key estável por empresa+período', () => {
  const a = reportIdempotencyKey('emp-1', '2026-09-12_2026-10-11');
  const b = reportIdempotencyKey('emp-1', '2026-09-12_2026-10-11');
  const c = reportIdempotencyKey('emp-1', '2026-10-12_2026-11-11');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^relatorio:emp-1:/);
});
