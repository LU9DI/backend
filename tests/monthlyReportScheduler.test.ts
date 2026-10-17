/**
 * Agendador in-process do relatório mensal: período alvo (mês UTC anterior),
 * gate de env e idempotência por período com retry em erro.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monthlyReportPeriodFor,
  monthlyReportSchedulerEnabled,
  runMonthlyReportSchedulerTick,
} from '../services/monthlyReportScheduler.js';
import type { MonthlyReportStats } from '../routes/monthlyReportJobsRoutes.js';

const SAVED_SCHEDULER = process.env.MONTHLY_REPORT_SCHEDULER;

function restoreEnv() {
  if (SAVED_SCHEDULER === undefined) delete process.env.MONTHLY_REPORT_SCHEDULER;
  else process.env.MONTHLY_REPORT_SCHEDULER = SAVED_SCHEDULER;
}

function fakeStats(periodo: string): MonthlyReportStats {
  return {
    periodo,
    candidatos: 0,
    encaminhados: 0,
    pulados: 0,
    falhas: 0,
    sem_destinatario: 0,
    distribuicao_indisponivel: 0,
    distribuicao_desativada: 0,
    snapshots_gerados: 0,
    snapshots_recuperados: 0,
  };
}

test('período alvo é o mês UTC anterior (virada de ano inclusive)', () => {
  assert.equal(monthlyReportPeriodFor(new Date('2026-10-17T12:00:00Z')), '2026-09');
  assert.equal(monthlyReportPeriodFor(new Date('2026-01-05T03:00:00Z')), '2025-12');
  assert.equal(monthlyReportPeriodFor(new Date('2026-03-01T00:30:00Z')), '2026-02');
});

test('agendador ligado por padrão e desligável por MONTHLY_REPORT_SCHEDULER', () => {
  try {
    delete process.env.MONTHLY_REPORT_SCHEDULER;
    assert.equal(monthlyReportSchedulerEnabled(), true);
    for (const v of ['0', 'false', 'off', 'OFF']) {
      process.env.MONTHLY_REPORT_SCHEDULER = v;
      assert.equal(monthlyReportSchedulerEnabled(), false);
    }
    process.env.MONTHLY_REPORT_SCHEDULER = '1';
    assert.equal(monthlyReportSchedulerEnabled(), true);
  } finally {
    restoreEnv();
  }
});

test('tick roda uma vez por período, reporta erro e tenta de novo no próximo tick', async () => {
  delete process.env.MONTHLY_REPORT_SCHEDULER;
  try {
    const calls: string[] = [];
    const run = async (_db: any, periodo: string) => { calls.push(periodo); return fakeStats(periodo); };

    const first = await runMonthlyReportSchedulerTick({ db: {}, run, now: new Date('2031-05-10T12:00:00Z') });
    assert.equal(first.ran, true);
    if (first.ran) assert.equal(first.periodo, '2031-04');
    assert.deepEqual(calls, ['2031-04']);

    const second = await runMonthlyReportSchedulerTick({ db: {}, run, now: new Date('2031-05-20T12:00:00Z') });
    assert.equal(second.ran, false);
    if (!second.ran) assert.equal(second.reason, 'already_ran');
    assert.deepEqual(calls, ['2031-04'], 'mesmo período não roda duas vezes no processo');

    const failing = await runMonthlyReportSchedulerTick({
      db: {},
      run: async () => { throw new Error('banco fora'); },
      now: new Date('2031-06-02T12:00:00Z'),
    });
    assert.equal(failing.ran, false);
    if (!failing.ran) assert.equal(failing.reason, 'error');

    const retry = await runMonthlyReportSchedulerTick({ db: {}, run, now: new Date('2031-06-03T12:00:00Z') });
    assert.equal(retry.ran, true);
    if (retry.ran) assert.equal(retry.periodo, '2031-05');
  } finally {
    restoreEnv();
  }
});

test('tick não executa quando desligado', async () => {
  process.env.MONTHLY_REPORT_SCHEDULER = '0';
  try {
    let called = false;
    const result = await runMonthlyReportSchedulerTick({
      db: {},
      run: async (_db: any, periodo: string) => { called = true; return fakeStats(periodo); },
      now: new Date('2031-07-10T12:00:00Z'),
    });
    assert.equal(result.ran, false);
    if (!result.ran) assert.equal(result.reason, 'disabled');
    assert.equal(called, false);
  } finally {
    restoreEnv();
  }
});
