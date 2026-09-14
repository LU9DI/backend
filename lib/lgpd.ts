/**
 * LGPD: anonimiza WhatsApp de reviews antigas.
 * Sem datetime/date/timestamptz no SQL — só JS.
 */
import type { Database } from 'sqlite';

const DEFAULT_DAYS = Number(process.env.LGPD_WHATSAPP_RETENTION_DAYS || 90);

export async function ensureReviewTreatmentColumns(db: Database): Promise<void> {
  for (const col of ['treated_at', 'treated_note', 'client_whatsapp'] as const) {
    try {
      await db.exec(`ALTER TABLE reviews ADD COLUMN ${col} TEXT`);
    } catch {
      /* exists */
    }
  }
}

function ms(v: unknown): number | null {
  if (v == null || v === '') return null;
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Nunca lança. Em falha retorna { anonymized: 0 }.
 */
export async function anonymizeOldClientWhatsapp(
  db: Database,
  opts?: { retentionDays?: number; limit?: number }
): Promise<{ anonymized: number }> {
  try {
    await ensureReviewTreatmentColumns(db);
  } catch {
    /* ignore */
  }

  const limit = Math.max(1, Math.min(500, opts?.limit ?? 200));
  const treatedCut = Date.now() - 7 * 86400000;
  const createdCut = Date.now() - (opts?.retentionDays ?? DEFAULT_DAYS) * 86400000;

  let rows: any[] = [];
  try {
    // SQL mínimo — sem função de data, sem comparação de timestamp
    rows = await db.all(
      `SELECT id, client_whatsapp FROM reviews WHERE client_whatsapp IS NOT NULL LIMIT 800`
    );
  } catch (e: any) {
    console.warn('LGPD select:', e?.message || e);
    return { anonymized: 0 };
  }

  const targets: string[] = [];
  for (const r of rows || []) {
    const w = String(r.client_whatsapp || '').trim();
    if (!w || w === '[anonimizado]') continue;
    const id = String(r.id);

    let treatedMs: number | null = null;
    let createdMs: number | null = null;
    try {
      const full = await db.get(`SELECT treated_at FROM reviews WHERE id = ?`, [id]);
      treatedMs = ms((full as any)?.treated_at);
    } catch {
      /* */
    }
    try {
      const full =
        (await db.get(`SELECT "createdAt" AS c FROM reviews WHERE id = ?`, [id])) ||
        (await db.get(`SELECT created_at AS c FROM reviews WHERE id = ?`, [id]));
      createdMs = ms((full as any)?.c);
    } catch {
      /* */
    }

    const okTreated = treatedMs != null && treatedMs <= treatedCut;
    const okCreated = createdMs != null && createdMs <= createdCut;
    if (okTreated || okCreated) targets.push(id);
    if (targets.length >= limit) break;
  }

  let anonymized = 0;
  for (const id of targets) {
    try {
      await db.run(`UPDATE reviews SET client_whatsapp = '[anonimizado]' WHERE id = ?`, [id]);
      anonymized++;
    } catch {
      /* */
    }
  }
  if (anonymized > 0) console.log(`🔒 LGPD ok: ${anonymized} anonimizado(s)`);
  return { anonymized };
}
