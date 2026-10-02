import crypto from 'crypto';
import { getDb } from './db.js';
import { enqueueRetry } from './retryQueue.js';
import { enviarEmailAquisicao } from './mailer.js';

const DAILY_CAP = Math.min(80, Math.max(1, Number(process.env.ACQUISITION_DAILY_CAP || 80)));
const INSTITUTIONAL_DAILY_TARGET = Math.min(30, DAILY_CAP);
const INSTITUTIONAL_KEYWORDS = /(associa[cç][aã]o|associacao|sindicato|federa[cç][aã]o|federacao|c[aâ]mara de com[eé]rcio|camara de comercio|entidade empresarial|uni[aã]o empresarial|conselho empresarial|instituto empresarial|confedera[cç][aã]o|confederacao)/i;
const ENGINE_INTERVAL_MS = Math.max(30_000, Number(process.env.ACQUISITION_ENGINE_INTERVAL_MS || 60_000));
const RESEND_SYNC_PAGE_SIZE = Math.min(100, Math.max(1, Number(process.env.RESEND_CONTACT_SYNC_PAGE_SIZE || 100)));
const RESEND_SYNC_MAX_PAGES = Math.min(20, Math.max(1, Number(process.env.RESEND_CONTACT_SYNC_MAX_PAGES || 5)));
const REPUTATION_MIN_SAMPLE = Math.max(10, Number(process.env.ACQUISITION_REPUTATION_MIN_SAMPLE || 25));
const REPUTATION_BOUNCE_LIMIT = Math.max(0.01, Math.min(0.04, Number(process.env.ACQUISITION_REPUTATION_BOUNCE_LIMIT || 0.04)));
const REPUTATION_COMPLAINT_LIMIT = 0.0008;

let started = false;
let running = false;

const clean = (v: unknown, n = 5000) => String(v ?? '').trim().slice(0, n);
const emailOk = (v: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(v, 320));
const unsubscribeSecret = () => clean(process.env.ACQUISITION_UNSUBSCRIBE_SECRET || process.env.JWT_SECRET, 500);
const unsubscribeToken = (leadId: string) => crypto.createHmac('sha256', unsubscribeSecret()).update(leadId).digest('hex');

async function acquisitionReputationGuard(db: any) {
  const from = localDayStartUtcIso();
  const [sentRow, bounceRow, complaintRow] = await Promise.all([
    db.get(`SELECT COUNT(*) AS c FROM acquisition_sends WHERE channel='email' AND status='sent' AND sent_at >= ?`, [from]),
    db.get(`SELECT COUNT(*) AS c FROM acquisition_events WHERE event_type='email.bounced' AND occurred_at >= ?`, [from]),
    db.get(`SELECT COUNT(*) AS c FROM acquisition_events WHERE event_type='email.complained' AND occurred_at >= ?`, [from])
  ]);
  const sent = Number(sentRow?.c || 0);
  const bounced = Number(bounceRow?.c || 0);
  const complained = Number(complaintRow?.c || 0);
  const bounceRate = sent ? bounced / sent : 0;
  const complaintRate = sent ? complained / sent : 0;
  const paused = complaintRate >= REPUTATION_COMPLAINT_LIMIT || complained > 0 || (sent >= REPUTATION_MIN_SAMPLE && bounceRate >= REPUTATION_BOUNCE_LIMIT);
  return { paused, sent, bounced, complained, bounce_rate: bounceRate, complaint_rate: complaintRate, reason: complained > 0 ? 'complaint' : (paused ? 'bounce_rate' : null) };
}

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
    ['acquisition_timezone', 'TEXT'],
    ['acquisition_segment', `TEXT NOT NULL DEFAULT 'business'`],
    ['acquisition_contact_basis', `TEXT`]
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

function isInstitutionalLead(lead: any) {
  if (String(lead?.acquisition_segment || '').toLowerCase() === 'institutional') return true;
  const haystack = [lead?.nome_empresa, lead?.fonte, lead?.acquisition_source, lead?.raw_json].map(v => clean(v, 20000)).join(' ');
  return INSTITUTIONAL_KEYWORDS.test(haystack);
}

async function institutionalSentToday(db: any) {
  const from = localDayStartUtcIso();
  const rows = await db.all(
    `SELECT l.nome_empresa,l.fonte,l.raw_json,l.acquisition_source,l.acquisition_segment
       FROM acquisition_sends s JOIN leads l ON l.id=s.lead_id
      WHERE s.channel='email' AND s.status IN ('queued','sent') AND s.scheduled_at >= ?`,
    [from]
  );
  return (rows || []).filter((row: any) => isInstitutionalLead(row)).length;
}

function buildMessage(lead: any) {
  const company = clean(lead.nome_empresa, 180) || 'sua empresa';
  const institutional = isInstitutionalLead(lead);
  const variant = crypto.createHash('sha256').update(String(lead.id)).digest('hex').charCodeAt(0) % 2 === 0 ? 'A' : 'B';
  const subject = institutional
    ? `Parceria com ${company}: auditoria gratuita para seus associados`
    : (variant === 'A'
      ? `Uma pergunta rápida sobre as avaliações da ${company}`
      : `Podemos fazer uma auditoria da ${company}?`);
  const url = 'https://filtraai.com/auditoria-gratuita?utm_source=acquisition&utm_medium=email&utm_campaign=2026-09&utm_content=' + variant.toLowerCase();
  const trackingBase = 'https://api.filtraai.com/api/public/acquisition';
  const unsubscribeUrl = trackingBase + '/unsubscribe?l=' + encodeURIComponent(String(lead.id)) + '&t=' + encodeURIComponent(unsubscribeToken(String(lead.id)));
  const clickUrl = trackingBase + '/click?l=' + encodeURIComponent(String(lead.id)) + '&u=' + encodeURIComponent(url);
  const openUrl = trackingBase + '/open?l=' + encodeURIComponent(String(lead.id));
  const body = institutional
    ? `Olá,

A Filtra.AI está oferecendo à ${company} uma iniciativa gratuita que pode ser disponibilizada aos seus associados: uma auditoria de reputação no Google.

A auditoria mostra a evolução das avaliações e notas, principais pontos de atenção nos comentários recentes, oportunidades de melhoria na reputação online e avaliações que ainda não receberam resposta.

Não há custo para a entidade. Os associados interessados também podem testar o Filtra.AI gratuitamente por 7 dias, sem cartão, para acompanhar avaliações, organizar feedback e utilizar a análise com IA.

A auditoria e o teste podem ser acessados diretamente:

${url}

Equipe Filtra.AI

Se não quiser receber novas comunicações da Filtra.AI, cancele aqui: ${unsubscribeUrl}`
    : `Olá,

Queria fazer uma pergunta rápida: vocês acompanham de forma estruturada o que os clientes estão dizendo nas avaliações?

A Filtra.AI transforma avaliações e feedback em oportunidades práticas para melhorar experiência, reputação e crescimento.

Podemos preparar uma auditoria gratuita da ${company}, sem compromisso?

${url}

Depois, se fizer sentido, você pode testar a plataforma por 7 dias.

Equipe filtra.ai

Se não quiser receber novas comunicações da Filtra.AI, cancele aqui: ${unsubscribeUrl}`;
  const safeCompany = company.replace(/[&<>"]/g, (m: string) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m] || m));
  const safeClickUrl = clickUrl.replace(/&/g, '&amp;');
  const safeUnsubscribeUrl = unsubscribeUrl.replace(/&/g, '&amp;');
  const html = institutional
    ? `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:24px;font-family:Arial,sans-serif;color:#202124;line-height:1.55"><div style="max-width:600px;margin:auto"><p>Olá <strong>${safeCompany}</strong>,</p><p>A <strong>Filtra.AI</strong> está oferecendo à entidade uma iniciativa gratuita que pode ser disponibilizada aos seus associados: uma auditoria de reputação no Google.</p><p>A auditoria mostra a evolução das avaliações e notas, principais pontos de atenção nos comentários recentes, oportunidades de melhoria na reputação online e avaliações que ainda não receberam resposta.</p><p>Não há custo para a entidade. Os associados interessados também podem testar o Filtra.AI gratuitamente por <strong>7 dias, sem cartão</strong>, para acompanhar avaliações, organizar feedback e utilizar a análise com IA.</p><p><a href="${safeClickUrl}" style="display:inline-block;padding:12px 18px;text-decoration:none;border-radius:6px;font-weight:700">Acessar auditoria gratuita</a></p><p>Auditoria e teste: <a href="https://filtraai.com">filtraai.com</a></p><p>Equipe Filtra.AI</p><p style="font-size:12px;color:#6b7280">Se não quiser receber novas comunicações da Filtra.AI, <a href="${safeUnsubscribeUrl}">clique aqui para cancelar</a>.</p><img src="${openUrl}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px" /></div></body></html>`
    : `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:24px;font-family:Arial,sans-serif;color:#202124;line-height:1.55"><div style="max-width:600px;margin:auto"><p>Olá,</p><p>Queria fazer uma pergunta rápida: vocês acompanham de forma estruturada o que os clientes estão dizendo nas avaliações?</p><p>A <strong>Filtra.AI</strong> transforma avaliações e feedback em oportunidades práticas para melhorar experiência, reputação e crescimento.</p><p>Podemos preparar uma auditoria gratuita da <strong>${safeCompany}</strong>, sem compromisso?</p><p><a href="${safeClickUrl}" style="display:inline-block;padding:12px 18px;text-decoration:none;border-radius:6px;font-weight:700">Ver auditoria gratuita</a></p><p>Depois, se fizer sentido, você pode testar a plataforma por 7 dias.</p><p>Equipe filtra.ai</p><p style="font-size:12px;color:#6b7280">Se não quiser receber novas comunicações da Filtra.AI, <a href="${safeUnsubscribeUrl}">clique aqui para cancelar</a>.</p><img src="${openUrl}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px" /></div></body></html>`;
  return { subject, body, html };
}

export async function queueEligibleAcquisition(limit = 25) {
  if (running) return { queued: 0, skipped: 0, reason: 'already_running' };
  running = true;
  try {
    const db = getDb();
    await ensureAcquisitionEngineSchema(db);

    // Contact synchronization is owned by the replenisher. Do not enumerate
    // Resend contacts on every engine tick: on a Free Render web service this
    // creates unnecessary outbound traffic and makes the web process carry
    // background work that is not required for each send decision.
    const resendFallback = { enabled: false, fetched: 0, created: 0, existing: 0, suppressed: 0, pages: 0, reason: 'managed_by_replenisher' };

    const reputation = await acquisitionReputationGuard(db);
    if (reputation.paused) return { queued: 0, skipped: 0, reason: 'reputation_pause', reputation };

    const used = await sentToday(db);
    const capacity = Math.max(0, DAILY_CAP - used);
    if (!capacity) return { queued: 0, skipped: 0, reason: 'daily_cap', resend_fallback: resendFallback };

    const take = Math.min(capacity, Math.max(1, limit));
    const institutionalSent = await institutionalSentToday(db);
    const institutionalRemaining = Math.max(0, INSTITUTIONAL_DAILY_TARGET - institutionalSent);
    const candidates = await db.all(
      `SELECT id,nome_empresa,email,fonte,raw_json,acquisition_source,acquisition_segment,acquisition_stage,acquisition_next_at
       FROM leads
       WHERE acquisition_eligible=1
         AND COALESCE(acquisition_suppressed,0)=0
         AND email IS NOT NULL AND TRIM(email)!=''
         AND (acquisition_opted_in_at IS NOT NULL OR acquisition_contact_basis = 'b2b_public_prospect')
         AND (acquisition_next_at IS NULL OR acquisition_next_at <= ?)
         AND acquisition_stage IN ('eligible','ready','followup')
       ORDER BY COALESCE(acquisition_next_at, criado_em) ASC
       LIMIT ?`,
      [new Date().toISOString(), Math.max(take * 4, INSTITUTIONAL_DAILY_TARGET)]
    );
    const institutional = (candidates || []).filter((lead: any) => isInstitutionalLead(lead));
    const general = (candidates || []).filter((lead: any) => !isInstitutionalLead(lead));
    const institutionalTake = Math.min(take, institutionalRemaining);
    // acquisition_eligible identifies a prospecting candidate.
    // Marketing sends require their applicable communication basis. Qualified
    // B2B public prospects may use the separate b2b_public_prospect basis;
    // marketing opt-in remains accepted for opted-in contacts.
    const leads = [
      ...institutional.slice(0, institutionalTake),
      ...general.slice(0, take - institutionalTake)
    ];

    if (!leads.length) {
      return { queued: 0, skipped: 0, capacity, used_before: used, reason: candidates?.length ? 'email_opt_in_required' : 'no_candidates', sendable_candidates: candidates?.length || 0, resend_fallback: resendFallback };
    }

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
    return { queued, skipped, capacity, used_before: used, institutional_sent_before: institutionalSent, institutional_target: INSTITUTIONAL_DAILY_TARGET, institutional_queued: leads.filter((lead: any) => isInstitutionalLead(lead)).length, resend_fallback: resendFallback };
  } finally {
    running = false;
  }
}

export function startAcquisitionWorker() {
  if (started || process.env.ACQUISITION_ENGINE === '0') return;
  started = true;
  console.log('[acquisition] worker enabled; explicit disable requires ACQUISITION_ENGINE=0');
  const tick = () => {
    queueEligibleAcquisition(25)
      .then(r => console.log('[acquisition]', r))
      .catch(e => console.warn('[acquisition worker]', e?.message || e));
  };
  tick();
  setInterval(tick, ENGINE_INTERVAL_MS);
}

export async function acquisitionEngineStatus() {
  const db = getDb();
  await ensureAcquisitionEngineSchema(db);
  const nowIso = new Date().toISOString();
  const reputation = await acquisitionReputationGuard(db);
  const [queued, sent, failed, eligible, sendable] = await Promise.all([
    db.get(`SELECT COUNT(*) AS c FROM acquisition_sends WHERE status='queued'`),
    db.get(`SELECT COUNT(*) AS c FROM acquisition_sends WHERE status='sent' AND sent_at >= ?`, [localDayStartUtcIso()]),
    db.get(`SELECT COUNT(*) AS c FROM acquisition_sends WHERE status='failed'`),
    db.get(`SELECT COUNT(*) AS c FROM leads WHERE acquisition_eligible=1 AND COALESCE(acquisition_suppressed,0)=0`),
    db.get(`SELECT COUNT(*) AS c FROM leads
      WHERE acquisition_eligible=1
        AND COALESCE(acquisition_suppressed,0)=0
        AND email IS NOT NULL AND TRIM(email)!=''
        AND (acquisition_opted_in_at IS NOT NULL OR acquisition_contact_basis = 'b2b_public_prospect')
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
    sendable_leads: Number(sendable?.c || 0),
    reputation_guard: reputation
  };
}

export async function processAcquisitionEmail(sendId: string) {
  const db = getDb();
  await ensureAcquisitionEngineSchema(db);
  const send = await db.get(
    `SELECT s.*,l.email,l.nome_empresa,l.acquisition_eligible,l.acquisition_opted_in_at,l.acquisition_contact_basis,l.acquisition_suppressed,l.acquisition_stage
     FROM acquisition_sends s JOIN leads l ON l.id=s.lead_id WHERE s.id=?`,
    [sendId]
  );
  if (!send) throw new Error('acquisition_send não encontrado');
  if (send.status === 'sent') return;
  const reputation = await acquisitionReputationGuard(db);
  if (reputation.paused) {
    await db.run(`UPDATE acquisition_sends SET status='failed',failed_at=CURRENT_TIMESTAMP,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [`reputation_pause:${reputation.reason}`, sendId]);
    throw new Error(`Envio pausado por reputação: ${reputation.reason}`);
  }
  const b2bPublicProspect = String(send.acquisition_contact_basis || '') === 'b2b_public_prospect';
  const hasMarketingOptIn = Boolean(send.acquisition_opted_in_at);
  if (Number(send.acquisition_eligible) !== 1 || Number(send.acquisition_suppressed || 0) === 1 || (!hasMarketingOptIn && !b2bPublicProspect)) {
    await db.run(`UPDATE acquisition_sends SET status='failed',failed_at=CURRENT_TIMESTAMP,last_error='lead não elegível/suprimido/sem base de contato',updated_at=CURRENT_TIMESTAMP WHERE id=?`, [sendId]);
    return;
  }

  const result = await enviarEmailAquisicao({
    to: String(send.email),
    subject: String(send.subject),
    text: String(send.body),
    html: buildMessage(send).html,
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
