/**
 * Web Push (PWA) — VAPID.
 *
 * Env:
 *   VAPID_PUBLIC_KEY=
 *   VAPID_PRIVATE_KEY=
 *   VAPID_SUBJECT=mailto:admin@seusaas.com
 *
 * Gerar chaves: npx web-push generate-vapid-keys
 *
 * Celular:
 * - Android Chrome: permitir notificações no painel (logado).
 * - iPhone: precisa **Adicionar à Tela de Início** (PWA); Safari sozinho não recebe push.
 */
import webpush from 'web-push';
import type { Database } from 'sqlite';
import crypto from 'crypto';

let configured = false;

const APP_URL = (
  process.env.APP_URL ||
  process.env.FRONTEND_URL ||
  'https://filtraai.com'
).replace(/\/$/, '');

export function pushConfigured(): boolean {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim()
  );
}

export function initWebPush() {
  if (!pushConfigured()) return false;
  if (configured) return true;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@filtraai.com',
    process.env.VAPID_PUBLIC_KEY!.trim(),
    process.env.VAPID_PRIVATE_KEY!.trim()
  );
  configured = true;
  return true;
}

export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY?.trim() || null;
}

export async function ensurePushSchema(db: Database) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      empresa_id TEXT,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT
    );
  `);
  try {
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_push_empresa ON push_subscriptions(empresa_id)`
    );
  } catch {
    /* ok */
  }
}

export type PushSubInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userId?: string | null;
  empresaId?: string | null;
  userAgent?: string | null;
};

export async function saveSubscription(db: Database, input: PushSubInput) {
  const now = new Date().toISOString();
  const existing = await db.get(
    `SELECT id FROM push_subscriptions WHERE endpoint = ?`,
    [input.endpoint]
  );
  if (existing) {
    await db.run(
      `UPDATE push_subscriptions
       SET p256dh = ?, auth = ?, user_id = COALESCE(?, user_id),
           empresa_id = COALESCE(?, empresa_id), user_agent = ?, last_seen_at = ?
       WHERE endpoint = ?`,
      [
        input.keys.p256dh,
        input.keys.auth,
        input.userId || null,
        input.empresaId || null,
        input.userAgent || null,
        now,
        input.endpoint,
      ]
    );
    return existing.id as string;
  }
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO push_subscriptions
     (id, user_id, empresa_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId || null,
      input.empresaId || null,
      input.endpoint,
      input.keys.p256dh,
      input.keys.auth,
      input.userAgent || null,
      now,
      now,
    ]
  );
  return id;
}

export async function removeSubscription(db: Database, endpoint: string) {
  await db.run(`DELETE FROM push_subscriptions WHERE endpoint = ?`, [endpoint]);
}

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  empresaId?: string;
};

function absoluteUrl(pathOrUrl?: string): string {
  if (!pathOrUrl) return APP_URL;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${APP_URL}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

async function sendOne(
  db: Database,
  row: any,
  payload: PushPayload
): Promise<'ok' | 'gone' | 'error'> {
  if (!initWebPush()) return 'error';
  try {
    await webpush.sendNotification(
      {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      },
      JSON.stringify({
        title: payload.title,
        body: payload.body,
        url: absoluteUrl(payload.url),
        tag: payload.tag || 'filtra',
      }),
      { TTL: 60 * 60 }
    );
    return 'ok';
  } catch (e: any) {
    const status = e?.statusCode || e?.status;
    if (status === 404 || status === 410) {
      await removeSubscription(db, row.endpoint);
      return 'gone';
    }
    console.warn('push fail:', status || e?.message);
    return 'error';
  }
}

export async function sendPushToEmpresa(
  db: Database,
  empresaId: string,
  payload: PushPayload
): Promise<{ sent: number; gone: number; errors: number; subscriptions: number }> {
  if (!initWebPush()) return { sent: 0, gone: 0, errors: 0, subscriptions: 0 };
  await ensurePushSchema(db);
  const rows = await db.all(
    `SELECT * FROM push_subscriptions WHERE empresa_id = ?`,
    [empresaId]
  );
  const list = rows || [];
  if (list.length === 0) {
    console.warn(
      `[push] nenhuma subscription para empresa=${empresaId} — usuário precisa permitir notificações logado no painel (celular: PWA no iOS)`
    );
  }
  let sent = 0,
    gone = 0,
    errors = 0;
  for (const row of list) {
    const r = await sendOne(db, row, payload);
    if (r === 'ok') sent++;
    else if (r === 'gone') gone++;
    else errors++;
  }
  return { sent, gone, errors, subscriptions: list.length };
}

export async function notifyCrisisReview(
  db: Database,
  opts: { empresaId: string; rating: number; name?: string; slugOrId?: string }
) {
  if (opts.rating > 3) return;
  if (!pushConfigured()) {
    console.warn('[push] crise ignorada — VAPID não configurado');
    return;
  }
  const ref = opts.slugOrId || opts.empresaId;
  const result = await sendPushToEmpresa(db, opts.empresaId, {
    title: 'Filtra.AI — crítica privada',
    body: `Nova avaliação ${opts.rating}★${opts.name ? ` de ${opts.name}` : ''}. Abra o painel.`,
    url: `/painel/${ref}`,
    tag: `crise-${opts.empresaId}`,
    empresaId: opts.empresaId,
  });
  console.log(
    `[push] crise empresa=${opts.empresaId} sent=${result.sent} subs=${result.subscriptions}`
  );
}
