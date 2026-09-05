import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateReportMonth,
  validateIsoDate,
  validateDateRange,
  currentMonthYYYYMM,
  compareYYYYMM,
} from '../lib/dateValidation.js';

describe('dateValidation', () => {
  const fixed = new Date(2026, 8, 5); // 5 set 2026

  it('currentMonthYYYYMM', () => {
    assert.equal(currentMonthYYYYMM(fixed), '2026-09');
  });

  it('aceita mês válido', () => {
    const r = validateReportMonth('2026-03', { now: fixed });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, '2026-03');
  });

  it('default = mês atual', () => {
    const r = validateReportMonth(undefined, { now: fixed });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, '2026-09');
  });

  it('rejeita formato errado', () => {
    const r = validateReportMonth('09/2026', { now: fixed });
    assert.equal(r.ok, false);
  });

  it('rejeita mês 13', () => {
    const r = validateReportMonth('2026-13', { now: fixed });
    assert.equal(r.ok, false);
  });

  it('rejeita mês 00', () => {
    const r = validateReportMonth('2026-00', { now: fixed });
    assert.equal(r.ok, false);
  });

  it('rejeita mês futuro', () => {
    const r = validateReportMonth('2026-12', { now: fixed, allowFutureMonths: 0 });
    assert.equal(r.ok, false);
  });

  it('rejeita ano muito antigo', () => {
    const r = validateReportMonth('2015-01', { now: fixed, minYear: 2020 });
    assert.equal(r.ok, false);
  });

  it('normaliza padding', () => {
    // input já deve ser YYYY-MM com 2 dígitos; 2026-3 não passa regex
    const r = validateReportMonth('2026-3', { now: fixed });
    assert.equal(r.ok, false);
  });

  it('ISO date válida', () => {
    const r = validateIsoDate('2026-02-28');
    assert.equal(r.ok, true);
  });

  it('ISO date inválida (31 fev)', () => {
    const r = validateIsoDate('2026-02-31');
    assert.equal(r.ok, false);
  });

  it('range invertido', () => {
    const r = validateDateRange('2026-03-01', '2026-01-01');
    assert.equal(r.ok, false);
  });

  it('compareYYYYMM', () => {
    assert.ok(compareYYYYMM('2026-01', '2026-02') < 0);
    assert.ok(compareYYYYMM('2026-09', '2026-09') === 0);
  });
});
