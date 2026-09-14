import type { Database } from 'sqlite';
import { assertReportConsistency, formatAverage, formatPercent, normalizeReportReviews } from './reportMetrics.js';

/**
 * Monta o payload determinístico enviado ao n8n.
 * Os números vêm exclusivamente do backend; a IA pode interpretar, mas não calcular.
 */
export async function buildN8nMonthlyReport(
  db: Database,
  empresaId: string,
  mesAno: string
): Promise<Record<string, unknown> | null> {
  const empresa = await db.get(
    'SELECT id, nome_empresa, slug, plan FROM empresas WHERE id = ?',
    [empresaId]
  );
  if (!empresa) return null;

  const rows = await db.all(
    `SELECT rating, comment, unidade_id, origin, createdAt
       FROM reviews
      WHERE empresa_id = ?
        AND strftime('%Y-%m', createdAt) = ?
        AND IFNULL(is_test, 0) = 0`,
    [empresaId, mesAno]
  );

  const metrics = normalizeReportReviews(rows);
  assertReportConsistency(metrics);
  if (metrics.invalidCount > 0) {
    throw new Error(
      `Integridade do relatório: ${metrics.invalidCount} avaliação(ões) com nota inválida no período ${mesAno}.`
    );
  }

  const recipient = await db.get(
    `SELECT email
       FROM usuarios
      WHERE empresa_id = ?
        AND email IS NOT NULL
        AND TRIM(email) <> ''
      ORDER BY id
      LIMIT 1`,
    [empresaId]
  );

  const comentarios = rows
    .map((r: any) => String(r.comment || '').trim())
    .filter(Boolean)
    .slice(0, 80);

  const idempotencyKey = `relatorio:${empresaId}:${mesAno}`;

  return {
    cliente_id: empresa.id,
    cliente_nome: empresa.nome_empresa,
    slug: empresa.slug || null,
    plano: String(empresa.plan || '').toLowerCase(),
    periodo: mesAno,
    idempotency_key: idempotencyKey,
    relatorio: {
      total: metrics.total,
      nota_media: metrics.average,
      nota_media_formatada: formatAverage(metrics.average, 1),
      positivas: metrics.positive,
      criticas: metrics.critical,
      taxa_positiva: formatPercent(metrics.positiveRate),
      taxa_critica: formatPercent(metrics.total ? metrics.critical / metrics.total : null),
      distribuicao: {
        '1': metrics.distribution[0],
        '2': metrics.distribution[1],
        '3': metrics.distribution[2],
        '4': metrics.distribution[3],
        '5': metrics.distribution[4],
      },
      integridade: {
        total_confere_distribuicao:
          metrics.distribution.reduce((sum, value) => sum + value, 0) === metrics.total,
        positivas_mais_criticas: metrics.positive + metrics.critical === metrics.total,
        avaliacoes_invalidas: metrics.invalidCount,
      },
      comentarios,
    },
    destinatarios: recipient?.email
      ? [{ channel: 'email', destination: String(recipient.email).trim() }]
      : [],
  };
}
