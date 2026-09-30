import crypto from 'crypto';
import { getDb } from './db.js';
import { enqueueRetry } from './retryQueue.js';

const DAILY_CAP = Math.min(80, Math.max(1, Number(process.env.ACQUISITION_DAILY_CAP || 80)));
const ENGINE_INTERVAL_MS = Math.max(30_000, Number(process.env.ACQUISITION_ENGINE_INTERVAL_MS || 60_000));

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
    const used = await sentToday(db);
    const capacity = Math.max(0, DAILY_CAP - used);
    if (!capacity) return { queued: 0, skipped: 0, reason: 'daily_cap' };

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
    return { queued, skipped, capacity, used_before: used };
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
