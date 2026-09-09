/**
 * LGPD leve: anonimiza WhatsApp de clientes em críticas antigas/tratadas.
 * Datas calculadas em JS (compatível Postgres + SQLite).
 */
import type { Database } from 'sqlite';

const DEFAULT_DAYS = Number(process.env.LGPD_WHATSAPP_RETENTION_DAYS || 90);

export async function ensureReviewTreatmentColumns(db: Database): Promise<void> {
  const cols = (await db.all(`PRAGMA table_info(reviews)`)).map((c: any) => c.name);
  if (!cols.includes('treated_at')) {
    try {
      await db.exec(`ALTER TABLE reviews ADD COLUMN treated_at TEXT`);
    } catch {
      /* */
    }
  }
  if (!cols.includes('treated_note')) {
    try {
      await db.exec(`ALTER TABLE reviews ADD COLUMN treated_note TEXT`);
    } catch {
      /* */
    }
  }
  if (!cols.includes('client_whatsapp')) {
    try {
      await db.exec(`ALTER TABLE reviews ADD COLUMN client_whatsapp TEXT`);
    } catch {
      /* */
    }
  }
}

export async function anonymizeOldClientWhatsapp(
  db: Database,
  opts?: { retentionDays?: number; limit?: number }
): Promise<{ anonymized: number }> {
  await ensureReviewTreatmentColumns(db);
  const days = opts?.retentionDays ?? DEFAULT_DAYS;
  const limit = opts?.limit ?? 500;

  const treatedCutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  const createdCutoff = new Date(Date.now() - days * 86400000).toISOString();

  // Evita datetime/date do SQLite — comparação ISO funciona em TIMESTAMPTZ/TEXT
  let rows: any[] = [];
  try {
    rows = await db.all(
      `SELECT id FROM reviews
       WHERE client_whatsapp IS NOT NULL
         AND TRIM(client_whatsapp) != ''
         AND client_whatsapp != '[anonimizado]'
         AND (
           (treated_at IS NOT NULL AND treated_at <= ?)
           OR ("createdAt" IS NOT NULL AND "createdAt" <= ?)
         )
       LIMIT ?`,
      [treatedCutoff, createdCutoff, limit]
    );
  } catch (e: any) {
    // fallback se createdAt sem aspas em algum schema
    console.warn('LGPD sweep query:', e?.message || e);
    try {
      rows = await db.all(
        `SELECT id FROM reviews
         WHERE client_whatsapp IS NOT NULL
           AND client_whatsapp != '[anonimizado]'
           AND treated_at IS NOT NULL AND treated_at <= ?
         LIMIT ?`,
        [treatedCutoff, limit]
      );
    } catch (e2: any) {
      console.warn('LGPD sweep skipped:', e2?.message || e2);
      return { anonymized: 0 };
    }
  }

  let anonymized = 0;
  for (const r of rows || []) {
    await db.run(`UPDATE reviews SET client_whatsapp = '[anonimizado]' WHERE id = ?`, [r.id]);
    anonymized += 1;
  }
  return { anonymized };
}
