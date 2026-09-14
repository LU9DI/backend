/**
 * Carrega reviews do painel de forma resiliente (SQLite + Postgres).
 * Evita 500 por coluna ausente ou createdAt sem aspas.
 */
import type { Database } from 'sqlite';

export type PainelReviewRow = {
  id: any;
  name: any;
  rating: any;
  comment: any;
  ai_reply: any;
  ai_tags: any;
  createdAt: any;
  is_test?: any;
  fraud_flags?: any;
  origin?: any;
  sentiment?: any;
  sentiment_score?: any;
  sentiment_source?: any;
  client_whatsapp?: any;
  treated_at?: any;
  treated_note?: any;
};

const QUERIES = [
  // Postgres / schema completo com camelCase
  `SELECT id, name, rating, comment, ai_reply, ai_tags, "createdAt" AS "createdAt",
          COALESCE(is_test, 0) AS is_test, fraud_flags, origin,
          sentiment, sentiment_score, sentiment_source,
          client_whatsapp, treated_at, treated_note
   FROM reviews WHERE empresa_id = ? ORDER BY "createdAt" DESC LIMIT 500`,
  // Sem sentiment
  `SELECT id, name, rating, comment, ai_reply, ai_tags, "createdAt" AS "createdAt",
          COALESCE(is_test, 0) AS is_test, fraud_flags, origin,
          client_whatsapp, treated_at, treated_note
   FROM reviews WHERE empresa_id = ? ORDER BY "createdAt" DESC LIMIT 500`,
  // Mínimo + createdAt quoted
  `SELECT id, name, rating, comment, ai_reply, ai_tags, "createdAt" AS "createdAt",
          COALESCE(is_test, 0) AS is_test
   FROM reviews WHERE empresa_id = ? ORDER BY "createdAt" DESC LIMIT 500`,
  // SQLite / unquoted createdAt
  `SELECT id, name, rating, comment, ai_reply, ai_tags, createdAt,
          COALESCE(is_test, 0) AS is_test, client_whatsapp, treated_at
   FROM reviews WHERE empresa_id = ? ORDER BY createdAt DESC LIMIT 500`,
  // Absolute mínimo
  `SELECT id, name, rating, comment, ai_reply, ai_tags, createdAt
   FROM reviews WHERE empresa_id = ? LIMIT 500`,
];

export async function loadPainelReviews(
  db: Database,
  empresaId: string
): Promise<PainelReviewRow[]> {
  let lastErr: any = null;
  for (const sql of QUERIES) {
    try {
      const rows = await db.all(sql, [empresaId]);
      return (rows || []) as PainelReviewRow[];
    } catch (e: any) {
      lastErr = e;
      console.warn('[painel reviews] try fail:', e?.message || e);
    }
  }
  console.error('[painel reviews] all queries failed:', lastErr?.message || lastErr);
  return [];
}
