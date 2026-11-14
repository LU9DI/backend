/**
 * Métrica read-only das reservas enviadas que ultrapassaram a carência.
 * Repete os predicados do sweep do ledger, mas nunca modifica o estado.
 */
export async function countPendingSentOverGrace(
  db: { get: (sql: string, params?: any[]) => Promise<any> },
  nowMs = Date.now(),
  configuredGraceMs = Number(process.env.DOT_SENT_GRACE_MS || 10 * 60_000),
): Promise<number | null> {
  const graceMs = Number.isFinite(configuredGraceMs)
    ? Math.max(0, configuredGraceMs)
    : 10 * 60_000;
  const now = new Date(nowMs).toISOString();
  const graceCutoff = new Date(nowMs - graceMs).toISOString();

  try {
    const row = await db.get(
      `SELECT COUNT(*) AS c FROM dot_budget_reservations
        WHERE status = 'pending' AND ambiguous = 0 AND sent_at IS NOT NULL
          AND expires_at <= ? AND sent_at <= ?`,
      [now, graceCutoff],
    );
    const count = Number(row?.c);
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}
