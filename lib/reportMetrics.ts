export type ReportReview = {
  rating: unknown;
  comment?: string | null;
  unidade_id?: string | null;
  origin?: string | null;
  createdAt?: string | null;
};

export type ReportMetrics = {
  validReviews: ReportReview[];
  invalidCount: number;
  distribution: [number, number, number, number, number];
  total: number;
  average: number | null;
  positive: number;
  critical: number;
  positiveRate: number | null;
};

/**
 * Normaliza avaliações antes de qualquer cálculo do relatório.
 * Somente notas inteiras de 1 a 5 entram nas métricas.
 */
export function normalizeReportReviews(reviews: ReportReview[]): ReportMetrics {
  const validReviews: ReportReview[] = [];
  let invalidCount = 0;
  const distribution: [number, number, number, number, number] = [0, 0, 0, 0, 0];

  for (const review of reviews) {
    const raw = review?.rating;
    const rating = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());

    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !Number.isFinite(rating)) {
      invalidCount += 1;
      continue;
    }

    validReviews.push({ ...review, rating });
    distribution[rating - 1] += 1;
  }

  const total = validReviews.length;
  const sum = validReviews.reduce((acc, review) => acc + Number(review.rating), 0);
  const average = total > 0 ? sum / total : null;
  const positive = distribution[3] + distribution[4];
  const critical = distribution[0] + distribution[1] + distribution[2];
  const positiveRate = total > 0 ? positive / total : null;

  return { validReviews, invalidCount, distribution, total, average, positive, critical, positiveRate };
}

export function roundHalfUp(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function formatAverage(value: number | null, decimals = 2): string {
  return value === null ? '—' : roundHalfUp(value, decimals).toFixed(decimals);
}

export function formatPercent(value: number | null, decimals = 0): string {
  if (value === null) return '—';
  return `${(roundHalfUp(value * 100, decimals)).toFixed(decimals)}%`;
}

export function assertReportConsistency(metrics: ReportMetrics): void {
  const distributionTotal = metrics.distribution.reduce((a, b) => a + b, 0);
  if (distributionTotal !== metrics.total) {
    throw new Error('Integridade do relatório: distribuição de notas não fecha com o total.');
  }
  if (metrics.positive + metrics.critical !== metrics.total) {
    throw new Error('Integridade do relatório: positivas + críticas não fecha com o total.');
  }
  if (metrics.total === 0 && (metrics.average !== null || metrics.positiveRate !== null)) {
    throw new Error('Integridade do relatório: métricas de um período vazio estão inconsistentes.');
  }
  if (metrics.total > 0 && (metrics.average === null || metrics.average < 1 || metrics.average > 5)) {
    throw new Error('Integridade do relatório: média fora da escala 1–5.');
  }
}
