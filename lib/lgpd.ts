/**
 * LGPD leve: anonimiza WhatsApp de clientes em críticas antigas/tratadas.
 * Compatível com Postgres (produção) e SQLite (dev).
 */

const DEFAULT_DAYS = Number(process.env.LGPD_WHATSAPP_RETENTION_DAYS || 90);

function isPostgres(): boolean {
  const url =
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.SUPABASE_DATABASE_URL ||
    '';
  return /postgres/i.test(url) || process.env.NODE_ENV === 'production';
}

export async function ensureReviewTreatmentColumns(db: any): Promise<void> {
  try {
    if (isPostgres()) {
      await db.exec(`
        ALTER TABLE reviews ADD COLUMN IF NOT EXISTS treated_at TIMESTAMPTZ;
        ALTER TABLE reviews ADD COLUMN IF NOT EXISTS treated_note TEXT;
        ALTER TABLE reviews ADD COLUMN IF NOT EXISTS client_whatsapp TEXT;
      `);
      return;
    }
  } catch {
    /* fallback abaixo */
  }

  try {
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
  } catch (e: any) {
    console.warn('ensureReviewTreatmentColumns:', e?.message || e);
  }
}

/**
 * Anonimiza client_whatsapp quando:
 * - já marcada como tratada há ≥ 7 dias, ou
 * - criada há mais de LGPD_WHATSAPP_RETENTION_DAYS (default 90)
 */
export async function anonymizeOldClientWhatsapp(
  db: any,
  opts?: { retentionDays?: number; limit?: number }
): Promise<{ anonymized: number }> {
  await ensureReviewTreatmentColumns(db);
  const days = opts?.retentionDays ?? DEFAULT_DAYS;
  const limit = opts?.limit ?? 500;

  let rows: any[] = [];
  try {
    if (isPostgres()) {
      rows = await db.all(
        `SELECT id FROM reviews
         WHERE client_whatsapp IS NOT NULL
           AND TRIM(client_whatsapp) <> ''
           AND client_whatsapp <> '[anonimizado]'
           AND (
             (treated_at IS NOT NULL AND treated_at <= NOW() - INTERVAL '7 days')
             OR ("createdAt" IS NOT NULL AND "createdAt" <= NOW() - ($1::text || ' days')::interval)
             OR (created_at IS NOT NULL AND created_at <= NOW() - ($1::text || ' days')::interval)
           )
         LIMIT $2`,
        [String(days), limit]
      );
    } else {
      rows = await db.all(
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
    }
  } catch (e: any) {
    // Coluna createdAt vs created_at — tenta query mínima
    console.warn('LGPD select:', e?.message || e);
    try {
      if (isPostgres()) {
        rows = await db.all(
          `SELECT id FROM reviews
           WHERE client_whatsapp IS NOT NULL
             AND TRIM(client_whatsapp) <> ''
             AND client_whatsapp <> '[anonimizado]'
             AND treated_at IS NOT NULL
             AND treated_at <= NOW() - INTERVAL '7 days'
           LIMIT $1`,
          [limit]
        );
      }
    } catch (e2: any) {
      console.warn('LGPD select fallback:', e2?.message || e2);
      return { anonymized: 0 };
    }
  }

  let anonymized = 0;
  for (const r of rows || []) {
    try {
      await db.run(
        `UPDATE reviews SET client_whatsapp = '[anonimizado]' WHERE id = ?`,
        [r.id]
      );
      anonymized += 1;
    } catch {
      /* ignora linha */
    }
  }
  return { anonymized };
}
