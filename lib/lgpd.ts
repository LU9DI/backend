/** LGPD: colunas + anonimização sem funções de data ambíguas no SQL. */
import type { Database } from 'sqlite';

const DEFAULT_DAYS = Number(process.env.LGPD_WHATSAPP_RETENTION_DAYS || 90);

export async function ensureReviewTreatmentColumns(db: Database): Promise<void> {
  for (const name of ['treated_at', 'treated_note', 'client_whatsapp'] as const) {
    try {
      await db.exec(`ALTER TABLE reviews ADD COLUMN ${name} TEXT`);
    } catch {
      /* exists */
    }
  }
}

export async function anonymizeOldClientWhatsapp(
  db: Database,
  opts?: { retentionDays?: number; limit?: number }
): Promise<{ anonymized: number }> {
  try {
    await ensureReviewTreatmentColumns(db);
  } catch {
    /* */
  }
  const limit = Math.max(1, Math.min(500, opts?.limit ?? 200));
  const treatedCut = Date.now() - 7 * 86400000;
  const createdCut = Date.now() - (opts?.retentionDays ?? DEFAULT_DAYS) * 86400000;

  let rows: any[] = [];
  try {
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
      if ((full as any)?.treated_at) treatedMs = new Date(String((full as any).treated_at)).getTime();
    } catch {
      /* */
    }
    try {
      const full =
        (await db.get(`SELECT "createdAt" AS c FROM reviews WHERE id = ?`, [id])) ||
        (await db.get(`SELECT createdAt AS c FROM reviews WHERE id = ?`, [id]));
      if ((full as any)?.c) createdMs = new Date(String((full as any).c)).getTime();
    } catch {
      /* */
    }
    const byT = treatedMs != null && Number.isFinite(treatedMs) && treatedMs <= treatedCut;
    const byC = createdMs != null && Number.isFinite(createdMs) && createdMs <= createdCut;
    if (byT || byC) targets.push(id);
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
  return { anonymized };
}
