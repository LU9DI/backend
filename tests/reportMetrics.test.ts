import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeReportReviews,
  assertReportConsistency,
  formatAverage,
  formatPercent,
} from '../lib/reportMetrics.js';

test('ignora notas inválidas e mantém os cálculos fechados', () => {
  const metrics = normalizeReportReviews([
    { rating: 1 },
    { rating: 2 },
    { rating: 3 },
    { rating: 4 },
    { rating: 5 },
    { rating: 4.5 },
    { rating: 0 },
    { rating: 6 },
    { rating: 'abc' },
    { rating: null },
  ]);

  assert.equal(metrics.invalidCount, 5);
  assert.equal(metrics.total, 5);
  assert.deepEqual(metrics.distribution, [1, 1, 1, 1, 1]);
  assert.equal(metrics.positive, 2);
  assert.equal(metrics.critical, 3);
  assert.equal(metrics.average, 3);
  assert.equal(metrics.positiveRate, 0.4);
  assertReportConsistency(metrics);
});

test('período sem avaliações não produz divisão por zero', () => {
  const metrics = normalizeReportReviews([]);
  assert.equal(metrics.total, 0);
  assert.equal(metrics.average, null);
  assert.equal(metrics.positiveRate, null);
  assert.deepEqual(metrics.distribution, [0, 0, 0, 0, 0]);
  assertReportConsistency(metrics);
  assert.equal(formatAverage(metrics.average), '—');
  assert.equal(formatPercent(metrics.positiveRate), '—');
});

test('formatação não cria percentuais ou médias com ruído de ponto flutuante', () => {
  assert.equal(formatAverage(4.6666666667), '4.67');
  assert.equal(formatPercent(1 / 3), '33%');
  assert.equal(formatPercent(1 / 3, 2), '33.33%');
});

test('média usa somente notas válidas', () => {
  const metrics = normalizeReportReviews([{ rating: 5 }, { rating: 1 }, { rating: -1 }, { rating: 10 }]);
  assert.equal(metrics.average, 3);
  assert.equal(metrics.total, 2);
  assertReportConsistency(metrics);
});
