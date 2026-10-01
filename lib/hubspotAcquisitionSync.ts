import { getDb } from './db.js';

const ENABLED = process.env.HUBSPOT_ACQUISITION_SYNC_ENABLED === '1';
const INTERVAL_MS = Math.max(60_000, Number(process.env.HUBSPOT_ACQUISITION_SYNC_INTERVAL_MS || 300_000));
const BATCH_SIZE = Math.max(1, Math.min(10, Number(process.env.HUBSPOT_ACQUISITION_SYNC_BATCH_SIZE || 10)));
const TOKEN = () => (process.env.HUBSPOT_PRIVATE_APP_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN || '').trim();

let started = false;
let running = false;

const clean = (v: unknown, n = 5000) => String(v ?? '').trim().slice(0, n);
const emailOk = (v: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(v, 320));

async function hubspot(path: string, init: RequestInit = {}) {
  const token = TOKEN();
  if (!token) throw new Error('HUBSPOT_PRIVATE_APP_TOKEN ausente');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json');
  const response = await fetch(`https://api.hubapi.com${path}`, { ...init, headers });
  const body: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HubSpot HTTP ${response.status}: ${clean(body?.message || body?.error || 'unknown', 800)}`);
  return body;
}

async function syncLead(lead: any) {
  const db = getDb();
  const email = clean(lead.email, 320).toLowerCase();
  if (!emailOk(email)) return { status: 'skipped' };

  // Email is the stable dedupe key; do not overwrite an existing HubSpot contact.
  const search = await hubspot('/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: ['email', 'firstname', 'lastname', 'company'],
      limit: 1,
    }),
  });

  let contactId = search?.results?.[0]?.id;
  if (!contactId) {
    const company = clean(lead.nome_empresa, 180);
    const properties: Record<string, string> = {
      email,
      company,
      lifecyclestage: 'lead',
    };
    contactId = (await hubspot('/crm/v3/objects/contacts', {
      method: 'POST',
      body: JSON.stringify({ properties }),
    }))?.id;
  }

  if (!contactId) throw new Error('HubSpot não retornou contact id');

  await db.run(
    `UPDATE leads SET crm_id=?, crm_status='synced' WHERE id=? AND (crm_id IS NULL OR crm_id='')`,
    [String(contactId), String(lead.id)],
  );
  return { status: 'synced', id: String(contactId) };
}

export async function runHubSpotAcquisitionSyncOnce() {
  if (running) return { ok: true, processed: 0, synced: 0 };
  running = true;
  try {
    const db = getDb();
    const leads = await db.all<any>(
      `SELECT id,nome_empresa,email,qualification,crm_id
       FROM leads
       WHERE COALESCE(acquisition_suppressed,0)=0
         AND COALESCE(crm_id,'')=''
         AND LOWER(COALESCE(qualification,'')) IN ('qualified','prospect')
         AND email IS NOT NULL
       ORDER BY criado_em ASC
       LIMIT ?`,
      [BATCH_SIZE],
    );
    let synced = 0;
    for (const lead of leads) {
      try {
        const result = await syncLead(lead);
        if (result.status === 'synced') synced++;
      } catch (e: any) {
        console.warn(`[hubspot-acquisition] lead=${lead.id} error=${clean(e?.message || e, 800)}`);
      }
    }
    console.log(`[hubspot-acquisition] processed=${leads.length} synced=${synced}`);
    return { ok: true, processed: leads.length, synced };
  } catch (e: any) {
    const error = clean(e?.message || e, 800);
    console.warn(`[hubspot-acquisition] skipped/error: ${error}`);
    return { ok: false, processed: 0, synced: 0, error };
  } finally {
    running = false;
  }
}

export async function startHubSpotAcquisitionSync() {
  if (started || !ENABLED) return;
  started = true;
  await runHubSpotAcquisitionSyncOnce();
  setInterval(() => void runHubSpotAcquisitionSyncOnce(), INTERVAL_MS);
  console.log(`[hubspot-acquisition] enabled; interval=${INTERVAL_MS}ms batch=${BATCH_SIZE}`);
}
