/**
 * LGPD leve: anonimiza WhatsApp de clientes em críticas antigas/tratadas.
 * Datas e cortes calculados em JavaScript (Postgres + SQLite).
 * Sem datetime()/date()/timestamptz() no SQL.
 */
import type { Database } from 'sqlite';

const DEFAULT_DAYS = Number(process.env.LGPD_WHATSAPP_RETENTION_DAYS || 90);

async function listReviewColumns(db: Database): Promise<Set<string>> {
  try {
    const rows = await db.all(`PRAGMA table_info(reviews)`);
    return new Set((rows || []).map((c: any) => String(c.name)));
  } catch {
    return new Set();
  }
}

export async function ensureReviewTreatmentColumns(db: Database): Promise<void> {
  const cols = await listReviewColumns(db);
  for (const name of ['treated_at', 'treated_note', 'client_whatsapp'] as const) {
    if (cols.has(name)) continue;
    try {
      await db.exec(`ALTER TABLE reviews ADD COLUMN ${name} TEXT`);
    } catch {
      /* already exists / engine mismatch */
    }
  }
}

function parseTime(v: unknown): number | null {
  if (v == null || v === '') return null;
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Anonimiza client_whatsapp quando:
 * - tratada há ≥ 7 dias, ou
 * - criada há mais de LGPD_WHATSAPP_RETENTION_DAYS (default 90)
 */
export async function anonymizeOldClientWhatsapp(
  db: Database,
  opts?: { retentionDays?: number; limit?: number }
): Promise<{ anonymized: number }> {
  await ensureReviewTreatmentColumns(db);
  const days = opts?.retentionDays ?? DEFAULT_DAYS;
  const limit = Math.max(1, Math.min(5000, opts?.limit ?? 500));

  const treatedCutoffMs = Date.now() - 7 * 86400000;
  const createdCutoffMs = Date.now() - days * 86400000;

  // SELECT mínimo — filtro de data em JS (evita timestamptz/date ambíguos no PG)
  let rows: any[] = [];
  try {
    rows = await db.all(
      `SELECT id, treated_at, "createdAt" AS created_at, client_whatsapp
       FROM reviews
       WHERE client_whatsapp IS NOT NULL
         AND client_whatsapp != ''
         AND client_whatsapp != '[anonimizado]'
       LIMIT ?`,
      [limit * 4]
    );
  } catch (e1: any) {
    try {
      rows = await db.all(
        `SELECT id, treated_at, createdAt AS created_at, client_whatsapp
         FROM reviews
         WHERE client_whatsapp IS NOT NULL
           AND client_whatsapp != ''
           AND client_whatsapp != '[anonimizado]'
         LIMIT ?`,
        [limit * 4]
      );
    } catch (e2: any) {
      console.warn('LGPD sweep query:', e2?.message || e1?.message || e2);
      return { anonymized: 0 };
    }
  }

  const toAnon: string[] = [];
  for (const r of rows || []) {
    const w = String(r.client_whatsapp || '').trim();
    if (!w || w === '[anonimizado]') continue;
    const treatedMs = parseTime(r.treated_at);
    const createdMs = parseTime(r.created_at);
    const byTreated = treatedMs != null && treatedMs <= treatedCutoffMs;
    const byCreated = createdMs != null && createdMs <= createdCutoffMs;
    if (byTreated || byCreated) toAnon.push(String(r.id));
    if (toAnon.length >= limit) break;
  }

  let anonymized = 0;
  for (const id of toAnon) {
    try {
      await db.run(`UPDATE reviews SET client_whatsapp = '[anonimizado]' WHERE id = ?`, [id]);
      anonymized += 1;
    } catch (e: any) {
      console.warn('LGPD anonymize row:', e?.message || e);
    }
  }
  if (anonymized > 0) {
    console.log(`🔒 LGPD: ${anonymized} WhatsApp(s) anonimizado(s)`);
  }
  return { anonymized };
}
