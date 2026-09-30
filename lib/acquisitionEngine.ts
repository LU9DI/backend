import crypto from 'crypto';
import { getDb } from './db.js';
import { enqueueRetry } from './retryQueue.js';

const DAILY_CAP = Math.min(80, Math.max(1, Number(process.env.ACQUISITION_DAILY_CAP || 80)));
const ENGINE_INTERVAL_MS = Math.max(30_000, Number(process.env.ACQUISITION_ENGINE_INTERVAL_MS || 60_000));
const RESEND_SYNC_PAGE_SIZE = Math.min(100, Math.max(1, Number(process.env.RESEND_CONTACT_SYNC_PAGE_SIZE || 100)));
const RESEND_SYNC_MAX_PAGES = Math.min(20, Math.max(1, Number(process.env.RESEND_CONTACT_SYNC_MAX_PAGES || 5)));

let started = false;
let running = false;

const clean = (v: unknown, n = 5000) => String(v ?? '').trim().slice(0, n);
const emailOk = (v: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(v, 320));

export async function ensureAcquisitionEngineSchema(db = getDb()) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      nome_empresa TEXT,
      email TEXT,
      telefone TEXT,
      fonte TEXT,
      maps_url TEXT,
      raw_json TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS acquisition_sends (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'email',
      status TEXT NOT NULL DEFAULT 'queued',
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      provider_message_id TEXT,
      scheduled_at TIMESTAMPTZ NOT NULL,
      sent_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const leadColumns = [
    ['acquisition_eligible', 'INTEGER NOT NULL DEFAULT 0'],
    ['acquisition_opted_in_at', 'TIMESTAMPTZ'],
    ['acquisition_suppressed', 'INTEGER NOT NULL DEFAULT 0'],
    ['acquisition_stage', `TEXT NOT NULL DEFAULT 'eligible'`],
    ['acquisition_next_at', 'TIMESTAMPTZ'],
    ['acquisition_last_sent_at', 'TIMESTAMPTZ'],
    ['acquisition_source', 'TEXT'],
    ['acquisition_timezone', 'TEXT']
  ];
  for (const [name, type] of leadColumns) {
    try { await db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${type}`); } catch {}
  }
  await db.exec('CREATE INDEX IF NOT EXISTS idx_acq_leads_ready ON leads(acquisition_eligible, acquisition_suppressed, acquisition_next_at)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_acq_sends_day ON acquisition_sends(status, scheduled_at)');
}

function localDayStartUtcIso(now = new Date()) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

async function sentToday(db: any) {
  const from = localDayStartUtcIso();
  const row = await db.get(
    `SELECT COUNT(*) AS c FROM acquisition_sends
     WHERE channel='email' AND status IN ('queued','sent')
       AND scheduled_at >= ?`,
    [from]
  );
  return Number(row?.c || 0);
}

/**
 * Replenishment fallback:
 * FullEnrich remains the preferred source, but Resend's existing Contacts
 * become a zero-credit fallback. We only import valid contacts that are not
 * unsubscribed, dedupe by normalized email, and never re-enable a lead that
 * was already locally suppressed.
 *
 * Resend documents GET /contacts with cursor pagination (limit <= 100).
 */
export async function syncResendContacts(db = getDb()) {
  const apiKey = clean(process.env.RESEND_CONTACTS_API_KEY);
  // Contact-management access is intentionally separate from the production
  // sending key. The production key is sending-only and must never be used
  // for contact enumeration or other management APIs.
  if (!apiKey) return { enabled: false, fetched: 0, created: 0, existing: 0, suppressed: 0, pages: 0 };

  let after = '';
  let pages = 0;
  let fetched = 0;
  let created = 0;
  let existing = 0;
  let suppressed = 0;

  try {
    while (pages < RESEND_SYNC_MAX_PAGES) {
      const params = new URLSearchParams({ limit: String(RESEND_SYNC_PAGE_SIZE) });
      if (after) params.set('after', after);

      const response = await fetch(`https://api.resend.com/contacts?${params.toString()}`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      const body: any = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.warn('[acquisition] Resend contact sync failed:', response.status, body?.message || body?.error || 'unknown');
        return { enabled: true, fetched, created, existing, suppressed, pages, error: `HTTP ${response.status}` };
      }

      pages++;
      const contacts = Array.isArray(body?.data) ? body.data : [];
      fetched += contacts.length;

      for (const contact of contacts) {
        const email = clean(contact?.email, 320).toLowerCase();
        if (!emailOk(email)) continue;

        const unsubscribed = contact?.unsubscribed === true;
        const props = (contact?.properties && typeof contact.properties === 'object') ? contact.properties : {};
        const company = clean(
          props.company_name || props.company || props.nome_empresa ||
          contact?.company_name || contact?.first_name || '',
          180
        ) || null;

        const lead = await db.get('SELECT id,acquisition_suppressed FROM leads WHERE LOWER(email)=? LIMIT 1', [email]);

        if (lead?.id) {
          existing++;
          if (unsubscribed) {
            await db.run(
              `UPDATE leads
               SET acquisition_suppressed=1, acquisition_eligible=0,
                   acquisition_stage='suppressed', acquisition_next_at=NULL,
                   acquisition_source=COALESCE(acquisition_source,'resend_existing')
               WHERE id=?`,
              [lead.id]
            );
            suppressed++;
          } else {
            // Do not overwrite a local suppression (bounce/complaint/manual opt-out).
            await db.run(
              `UPDATE leads
               SET nome_empresa=COALESCE(NULLIF(nome_empresa,''),?),
                   acquisition_source=COALESCE(acquisition_source,'resend_existing')
               WHERE id=? AND COALESCE(acquisition_suppressed,0)=0`,
              [company, lead.id]
            );
          }
          continue;
        }

        if (unsubscribed) {
          // Preserve the opt-out in the central lead table so this contact
          // cannot later enter the acquisition queue accidentally.
          const id = crypto.randomUUID();
          await db.run(
            `INSERT INTO leads
             (id,nome_empresa,email,fonte,raw_json,criado_em,acquisition_eligible,
              acquisition_suppressed,acquisition_stage,acquisition_source)
             VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,0,1,'suppressed','resend_existing')`,
            [id, company, email, 'resend', JSON.stringify({resend_contact_id: contact?.id || null, unsubscribed: true}).slice(0,20000)]
          );
          suppressed++;
          created++;
          continue;
        }

        const id = crypto.randomUUID();
        await db.run(
          `INSERT INTO leads
           (id,nome_empresa,email,fonte,raw_json,criado_em,acquisition_eligible,
            acquisition_suppressed,acquisition_stage,acquisition_next_at,acquisition_source)
           VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,1,0,'ready',CURRENT_TIMESTAMP,'resend_existing')`,
          [id, company, email, 'resend', JSON.stringify({
            resend_contact_id: contact?.id || null,
            first_name: contact?.first_name || null,
            last_name: contact?.last_name || null,
            properties: props
          }).slice(0,20000)]
        );
        created++;
      }

      const hasMore = body?.has_more === true;
      const last = contacts[contacts.length - 1];
      if (!hasMore || !last?.id) break;
      after = String(last.id);
    }
  } catch (e: any) {
    console.warn('[acquisition] Resend contact sync exception:', e?.message || e);
    return { enabled: true, fetched, created, existing, suppressed, pages, error: String(e?.message || e).slice(0,300) };
  }

  return { enabled: true, fetched, created, existing, suppressed, pages };
}

function buildMessage(lead: any) {
  const company = clean(lead.nome_empresa, 180) || 'sua empresa';
  const subject = `Uma forma simples de transformar avaliações em crescimento — ${company}`;
  const body =
`Olá,

A Filtra.AI ajuda empresas a transformar avaliações e feedback dos clientes em sinais acionáveis para melhorar experiência, reputação e crescimento.

Se sua equipe já recebe avaliações de clientes, podemos fazer um diagnóstico gratuito da presença digital da ${company} e mostrar onde existem oportunidades de melhoria.

Auditoria gratuita:
https://filtraai.com/auditoria-gratuita

Depois, se fizer sentido, há 7 dias para testar a plataforma.

Equipe filtra.ai

Se você não quiser receber comunicações da Filtra.AI, basta responder a este e-mail solicitando a remoção.`;
  return { subject, body };
}

export async function queueEligibleAcquisition(limit = 25) {
  if (running) return { queued: 0, skipped: 0, reason: 'already_running' };
  running = true;
  try {
    const db = getDb();
    await ensureAcquisitionEngineSchema(db);

    // Optional contact-management fallback. It requires a separate
    // RESEND_CONTACTS_API_KEY; the production sending key is never reused here.
    const resendFallback = await syncResendContacts(db);

    const used = await sentToday(db);
    const capacity = Math.max(0, DAILY_CAP - used);
    if (!capacity) return { queued: 0, skipped: 0, reason: 'daily_cap', resend_fallback: resendFallback };

    const take = Math.min(capacity, Math.max(1, limit));
    const leads = await db.all(
      `SELECT id,nome_empresa,email,acquisition_stage,acquisition_next_at
       FROM leads
       WHERE acquisition_eligible=1
         AND COALESCE(acquisition_suppressed,0)=0
         AND email IS NOT NULL AND TRIM(email)!=''
         AND (acquisition_next_at IS NULL OR acquisition_next_at <= ?)
         AND acquisition_stage IN ('eligible','ready','followup')
       ORDER BY COALESCE(acquisition_next_at, criado_em) ASC
       LIMIT ?`,
      [new Date().toISOString(), take]
    );

    let queued = 0;
    let skipped = 0;
    for (const lead of leads || []) {
      const email = clean(lead.email, 320).toLowerCase();
      if (!emailOk(email)) { skipped++; continue; }
      const msg = buildMessage(lead);
      const id = crypto.randomUUID();
      const key = `acquisition:${lead.id}:initial`;
      try {
        await db.run(
          `INSERT INTO acquisition_sends
           (id,lead_id,channel,status,subject,body,idempotency_key,scheduled_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          [id, String(lead.id), 'email', 'queued', msg.subject, msg.body, key, new Date().toISOString()]
        );
        await db.run(
          `UPDATE leads SET acquisition_stage='queued', acquisition_next_at=NULL, updated_at=CURRENT_TIMESTAMP
           WHERE id=? AND acquisition_eligible=1 AND COALESCE(acquisition_suppressed,0)=0`,
          [lead.id]
        ).catch(async () => {
          await db.run(
            `UPDATE leads SET acquisition_stage='queued', acquisition_next_at=NULL WHERE id=? AND acquisition_eligible=1`,
            [lead.id]
          );
        });
        await enqueueRetry({
          jobType: 'acquisition_email',
          payload: { send_id: id },
          dedupeKey: `acquisition_send:${id}`,
        }, db);
        queued++;
      } catch (e: any) {
        if (/duplicate|unique|constraint/i.test(String(e?.message || e))) skipped++;
        else throw e;
      }
    }
    return { queued, skipped, capacity, used_before: used, resend_fallback: resendFallback };
  } finally {
    running = false;
  }
}

export function startAcquisitionWorker() {
  if (started || process.env.ACQUISITION_ENGINE !== '1') return;
  started = true;
  const tick = () => {
    queueEligibleAcquisition(25)
      .then(r => {
        if (r.queued || r.reason === 'daily_cap') console.log('[acquisition]', r);
      })
      .catch(e => console.warn('[acquisition worker]', e?.message || e));
  };
  tick();
  setInterval(tick, ENGINE_INTERVAL_MS);
}

export async function acquisitionEngineStatus() {
  const db = getDb();
  await ensureAcquisitionEngineSchema(db);
  const nowIso = new Date().toISOString();
  const [queued, sent, failed, eligible, sendable] = await Promise.all([
    db.get(`SELECT COUNT(*) AS c FROM acquisition_sends WHERE status='queued'`),
    db.get(`SELECT COUNT(*) AS c FROM acquisition_sends WHERE status='sent' AND sent_at >= ?`, [localDayStartUtcIso()]),
    db.get(`SELECT COUNT(*) AS c FROM acquisition_sends WHERE status='failed'`),
    db.get(`SELECT COUNT(*) AS c FROM leads WHERE acquisition_eligible=1 AND COALESCE(acquisition_suppressed,0)=0`),
    db.get(`SELECT COUNT(*) AS c FROM leads
      WHERE acquisition_eligible=1 AND COALESCE(acquisition_suppressed,0)=0
        AND email IS NOT NULL AND TRIM(email)!=''
        AND (acquisition_next_at IS NULL OR acquisition_next_at <= ?)
        AND acquisition_stage IN ('eligible','ready','followup')`, [nowIso])
  ]);
  return {
    enabled: process.env.ACQUISITION_ENGINE === '1',
    daily_cap: DAILY_CAP,
    queued: Number(queued?.c || 0),
    sent_today: Number(sent?.c || 0),
    failed: Number(failed?.c || 0),
    eligible_leads: Number(eligible?.c || 0),
    sendable_leads: Number(sendable?.c || 0)
  };
}

export async function processAcquisitionEmail(sendId: string, enviarEmail: Function) {
  const db = getDb();
  await ensureAcquisitionEngineSchema(db);
  const send = await db.get(
    `SELECT s.*,l.email,l.acquisition_eligible,l.acquisition_suppressed,l.acquisition_stage
     FROM acquisition_sends s JOIN leads l ON l.id=s.lead_id WHERE s.id=?`,
    [sendId]
  );
  if (!send) throw new Error('acquisition_send não encontrado');
  if (send.status === 'sent') return;
  if (Number(send.acquisition_eligible) !== 1 || Number(send.acquisition_suppressed || 0) === 1) {
    await db.run(`UPDATE acquisition_sends SET status='failed',failed_at=CURRENT_TIMESTAMP,last_error='lead não elegível/suprimido',updated_at=CURRENT_TIMESTAMP WHERE id=?`, [sendId]);
    return;
  }

  const result = await enviarEmail({
    to: String(send.email),
    subject: String(send.subject),
    text: String(send.body),
    idempotencyKey: String(send.idempotency_key)
  });
  if (!result.ok) {
    await db.run(`UPDATE acquisition_sends SET status='failed',failed_at=CURRENT_TIMESTAMP,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [String(result.error || 'envio falhou').slice(0,500), sendId]);
    throw new Error(String(result.error || 'envio falhou'));
  }

  const now = new Date().toISOString();
  await db.run(`UPDATE acquisition_sends SET status='sent',provider_message_id=?,sent_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    [result.messageId || null, now, sendId]);
  await db.run(
    `UPDATE leads SET acquisition_stage='contacted', acquisition_last_sent_at=?, acquisition_next_at=NULL WHERE id=?`,
    [now, send.lead_id]
  );
  await db.run(
    `INSERT INTO acquisition_events
      (id,lead_id,event_type,source,occurred_at,metadata_json)
      VALUES (?,?,?,?,?,?)`,
    [crypto.randomUUID(), String(send.lead_id), 'email.sent', 'filtra-backend', now,
      JSON.stringify({send_id: sendId, provider_message_id: result.messageId || null}).slice(0,20000)]
  );
}
