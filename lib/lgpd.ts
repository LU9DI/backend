/**
 * LGPD leve: anonimiza WhatsApp de clientes em críticas antigas/tratadas.
 */
import type { Database } from 'sqlite';

const DEFAULT_DAYS = Number(process.env.LGPD_WHATSAPP_RETENTION_DAYS || 90);

export async function ensureReviewTreatmentColumns(db: Database): Promise<void> {
  const cols = (await db.all(`PRAGMA table_info(reviews)`)).map((c: any) => c.name);
  if (!cols.includes('treated_at')) {
    await db.exec(`ALTER TABLE reviews ADD COLUMN treated_at TEXT`);
  }
  if (!cols.includes('treated_note')) {
    await db.exec(`ALTER TABLE reviews ADD COLUMN treated_note TEXT`);
  }
  if (!cols.includes('client_whatsapp')) {
    await db.exec(`ALTER TABLE reviews ADD COLUMN client_whatsapp TEXT`);
  }
}

/**
 * Anonimiza client_whatsapp quando:
 * - já marcada como tratada há ≥ 7 dias, ou
 * - criada há mais de LGPD_WHATSAPP_RETENTION_DAYS (default 90)
 */
export async function anonymizeOldClientWhatsapp(
  db: Database,
  opts?: { retentionDays?: number; limit?: number }
): Promise<{ anonymized: number }> {
  await ensureReviewTreatmentColumns(db);
  const days = opts?.retentionDays ?? DEFAULT_DAYS;
  const limit = opts?.limit ?? 500;

  const rows = await db.all(
    `SELECT id FROM reviews
     WHERE client_whatsapp IS NOT NULL
       AND TRIM(client_whatsapp) != ''
       AND client_whatsapp != '[anonimizado]'
       AND (
         (treated_at IS NOT NULL AND datetime(treated_at) <= datetime('now', '-7 days'))
         OR datetime(createdAt) <= datetime('now', '-' || ? || ' days')
       )
     LIMIT ?`,
    [String(days), limit]
  );

  let anonymized = 0;
  for (const r of rows || []) {
    await db.run(
      `UPDATE reviews SET client_whatsapp = '[anonimizado]' WHERE id = ?`,
      [r.id]
    );
    anonymized += 1;
  }
  return { anonymized };
}
