/**
 * LGPD leve: anonimiza WhatsApp antigo.
 * Zero funções de data no SQL (compatível Postgres).
 */
import type { Database } from 'sqlite';

const DEFAULT_DAYS = Number(process.env.LGPD_WHATSAPP_RETENTION_DAYS || 90);

export async function ensureReviewTreatmentColumns(db: Database): Promise<void> {
  // Só tenta ALTER — sem depender de PRAGMA (evita falhas no boot)
  for (const name of ['treated_at', 'treated_note', 'client_whatsapp'] as const) {
    try {
      await db.exec(`ALTER TABLE reviews ADD COLUMN ${name} TEXT`);
    } catch {
      /* coluna já existe */
    }
  }
}

function parseTime(v: unknown): number | null {
  if (v == null || v === '') return null;
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Anonimiza client_whatsapp se:
 * - treated_at há ≥ 7 dias, ou
 * - createdAt há ≥ retentionDays (default 90)
 * Nunca propaga erro ao caller.
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

  const days = opts?.retentionDays ?? DEFAULT_DAYS;
  const limit = Math.max(1, Math.min(2000, opts?.limit ?? 500));
  const treatedCutoffMs = Date.now() - 7 * 86400000;
  const createdCutoffMs = Date.now() - days * 86400000;

  // Queries candidatas — do mais seguro ao mais antigo schema
  const candidates: Array<{ sql: string; params: any[] }> = [
    {
      sql: `SELECT id, treated_at, client_whatsapp FROM reviews
            WHERE client_whatsapp IS NOT NULL AND client_whatsapp <> '' AND client_whatsapp <> '[anonimizado]'
            LIMIT ${limit * 3}`,
      params: [],
    },
    {
      sql: `SELECT id, client_whatsapp FROM reviews
            WHERE client_whatsapp IS NOT NULL AND client_whatsapp <> '[anonimizado]'
            LIMIT ${limit * 3}`,
      params: [],
    },
  ];

  let rows: any[] = [];
  for (const c of candidates) {
    try {
      rows = await db.all(c.sql, c.params);
      break;
    } catch (e: any) {
      console.warn('LGPD select try:', e?.message || e);
    }
  }
  if (!rows.length) return { anonymized: 0 };

  // Busca createdAt em query separada só para ids candidatos (opcional)
  const createdMap = new Map<string, number | null>();
  try {
    const ids = rows.map((r) => String(r.id)).slice(0, limit * 3);
    if (ids.length) {
      // Uma linha por vez evita ANY/IN quirks entre engines
      for (const id of ids) {
        try {
          const row =
            (await db.get(`SELECT "createdAt" AS c FROM reviews WHERE id = ?`, [id])) ||
            (await db.get(`SELECT createdAt AS c FROM reviews WHERE id = ?`, [id]));
          createdMap.set(id, parseTime((row as any)?.c));
        } catch {
          createdMap.set(id, null);
        }
      }
    }
  } catch {
    /* sem createdAt — só usa treated_at */
  }

  const toAnon: string[] = [];
  for (const r of rows) {
    const id = String(r.id);
    const w = String(r.client_whatsapp || '').trim();
    if (!w || w === '[anonimizado]') continue;

    const treatedMs = parseTime(r.treated_at);
    const createdMs = createdMap.has(id) ? createdMap.get(id)! : null;

    const byTreated = treatedMs != null && treatedMs <= treatedCutoffMs;
    const byCreated = createdMs != null && createdMs <= createdCutoffMs;
    // Se não há data nenhuma, não anonimiza por segurança
    if (byTreated || byCreated) toAnon.push(id);
    if (toAnon.length >= limit) break;
  }

  let anonymized = 0;
  for (const id of toAnon) {
    try {
      const r = await db.run(
        `UPDATE reviews SET client_whatsapp = '[anonimizado]' WHERE id = ? AND client_whatsapp IS NOT NULL AND client_whatsapp <> '[anonimizado]'`,
        [id]
      );
      if ((r as any)?.changes > 0) anonymized += 1;
      else anonymized += 1; // alguns adapters não reportam changes
    } catch (e: any) {
      console.warn('LGPD update:', e?.message || e);
    }
  }

  if (anonymized > 0) console.log(`🔒 LGPD: ${anonymized} WhatsApp(s) anonimizado(s)`);
  return { anonymized };
}
