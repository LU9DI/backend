import crypto from 'crypto';
import { getDb } from './db.js';
import { ensureAcquisitionEngineSchema } from './acquisitionEngine.js';
import { googlePlacesLeads } from './acquisitionGooglePlaces.js';

const MIN_STOCK = Math.max(80, Number(process.env.ACQUISITION_MIN_STOCK || 560));
const BATCH_SIZE = Math.min(200, Math.max(1, Number(process.env.ACQUISITION_REPLENISH_BATCH || 200)));
const INTERVAL_MS = Math.max(60000, Number(process.env.ACQUISITION_REPLENISH_INTERVAL_MS || 600000));
const FULLENRICH_BASE = 'https://app.fullenrich.com/api/v2';

let running = false;
let started = false;
let fullEnrichCooldownUntil = 0;

const clean = (v: unknown, n = 5000) => String(v ?? '').trim().slice(0, n);
const validEmail = (v: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(v, 320));
const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

const countries = ['Brazil', 'Portugal', 'Spain', 'Mexico', 'Argentina', 'Chile', 'Colombia'];
const titles = [
  'CEO', 'Chief Executive Officer', 'Founder', 'Owner',
  'Chief Marketing Officer', 'Head of Marketing', 'Marketing Director',
  'Head of Customer Success', 'Customer Success Director',
  'Head of Operations', 'Operations Director', 'General Manager',
];
const seniorities = ['Owner', 'Founder', 'C-level', 'Head', 'Director', 'VP'];
const headcounts = [{ min: 1, max: 500, exclude: false }];

function filterValues(values: string[]) {
  return values.map(value => ({ value, exact_match: false, exclude: false }));
}

function providerUrl() {
  return clean(process.env.ACQUISITION_REPLENISH_URL, 2000) || `${FULLENRICH_BASE}/people/search`;
}

function providerToken() {
  return clean(process.env.ACQUISITION_REPLENISH_TOKEN || process.env.FULLENRICH_API_KEY, 1000);
}

async function fullEnrichRequest(path: string, init: RequestInit = {}) {
  const token = providerToken();
  if (!token) throw new Error('FullEnrich API key ausente');
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  headers.set('content-type', 'application/json');
  const response = await fetch(`${FULLENRICH_BASE}${path}`, { ...init, headers });
  const raw = await response.text();
  let data: any = {};
  try { data = JSON.parse(raw); } catch { data = { raw }; }
  if (!response.ok) throw new Error(`FullEnrich HTTP ${response.status}: ${clean(data?.message || data?.error || raw, 500)}`);
  return data;
}

async function searchPeople(limit: number) {
  const results: any[] = [];
  let cursor: string | undefined;
  const target = Math.min(200, Math.max(1, limit));
  while (results.length < target) {
    const payload: any = {
      offset: 0,
      limit: Math.min(100, target - results.length),
      current_company_headcounts: headcounts,
      person_locations: filterValues(countries),
      current_position_titles: filterValues(titles),
      current_position_seniority_level: filterValues(seniorities),
    };
    if (cursor) payload.search_after = cursor;
    const data = await fullEnrichRequest('/people/search', { method: 'POST', body: JSON.stringify(payload) });
    const people = Array.isArray(data?.people) ? data.people : [];
    results.push(...people);
    const next = clean(data?.metadata?.search_after, 2000);
    if (!next || people.length === 0 || people.length < payload.limit) break;
    cursor = next;
  }
  return results;
}

function toEnrichmentInput(person: any) {
  const current = person?.employment?.current || {};
  const company = current?.company || {};
  const social = person?.social_profiles?.professional_network || {};
  const fullName = clean(person?.full_name || person?.name, 200);
  const parts = fullName.split(/\s+/).filter(Boolean);
  const firstName = clean(person?.first_name || parts.shift() || '', 120);
  const lastName = clean(person?.last_name || parts.join(' '), 120);
  const domain = clean(company?.domain, 200);
  const companyName = clean(company?.name, 200);
  const linkedin = clean(social?.url, 500);
  if ((!firstName || !lastName || (!domain && !companyName)) && !linkedin) return null;
  return {
    first_name: firstName,
    last_name: lastName,
    domain: domain || undefined,
    company_name: companyName || undefined,
    linkedin_url: linkedin || undefined,
    enrich_fields: ['contact.work_emails'],
    custom: { source: 'filtra_acquisition_engine', person_id: clean(person?.id, 180) },
  };
}

async function enrichBatch(people: any[]) {
  const data = people.map(toEnrichmentInput).filter(Boolean).slice(0, 100);
  if (!data.length) return [];
  const started = await fullEnrichRequest('/contact/enrich/bulk', {
    method: 'POST',
    body: JSON.stringify({ name: `Filtra acquisition ${new Date().toISOString()}`, data }),
  });
  const id = clean(started?.enrichment_id, 200);
  if (!id) throw new Error('FullEnrich não retornou enrichment_id');
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const result = await fullEnrichRequest(`/contact/enrich/bulk/${encodeURIComponent(id)}`);
    const status = String(result?.status || '').toUpperCase();
    if (status === 'FINISHED' || status === 'COMPLETED') return Array.isArray(result?.data) ? result.data : [];
    if (status === 'FAILED' || status === 'ERROR') throw new Error(`FullEnrich enrichment ${id} terminou com ${status}`);
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error(`FullEnrich enrichment ${id} excedeu o timeout de 180s`);
}

function timezoneFor(countryCode: string) {
  const map: Record<string, string> = {
    BR: 'America/Sao_Paulo', PT: 'Europe/Lisbon', ES: 'Europe/Madrid',
    MX: 'America/Mexico_City', AR: 'America/Argentina/Buenos_Aires',
    CL: 'America/Santiago', CO: 'America/Bogota',
  };
  return map[countryCode] || null;
}

function mapEnriched(item: any) {
  const email = clean(item?.contact_info?.most_probable_work_email?.email, 320).toLowerCase();
  const status = clean(item?.contact_info?.most_probable_work_email?.status, 80).toUpperCase();
  if (!validEmail(email) || ['INVALID', 'UNDELIVERABLE'].includes(status)) return null;
  const profile = item?.profile || {};
  const current = profile?.employment?.current || {};
  const company = current?.company || {};
  const countryCode = clean(profile?.location?.country_code, 8).toUpperCase();
  return {
    id: `fullenrich-${hash(email).slice(0, 32)}`,
    email,
    name: clean(profile?.full_name, 200),
    company: clean(company?.name || item?.input?.company_name, 200),
    title: clean(current?.title || profile?.headline, 240),
    timezone: timezoneFor(countryCode),
    source: 'FullEnrich',
    status,
    profile,
  };
}

async function fullEnrichProvider() {
  const url = providerUrl();
  if (url !== `${FULLENRICH_BASE}/people/search`) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const token = providerToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ limit: BATCH_SIZE, min_stock: MIN_STOCK, exclude_existing: true, require_professional_email: true, source: 'filtra_acquisition_engine' }),
    });
    const raw = await response.text();
    let data: any = {};
    try { data = JSON.parse(raw); } catch {}
    if (!response.ok) throw new Error(`replenishment provider HTTP ${response.status}`);
    return { leads: Array.isArray(data?.leads) ? data.leads : (Array.isArray(data) ? data : []) };
  }

  const people = await searchPeople(BATCH_SIZE);
  const out: any[] = [];
  for (let i = 0; i < people.length; i += 100) {
    const enriched = await enrichBatch(people.slice(i, i + 100));
    for (const item of enriched) {
      const mapped = mapEnriched(item);
      if (mapped) out.push(mapped);
    }
  }
  return { leads: out };
}

function providerOrder() {
  return clean(process.env.ACQUISITION_PROVIDERS || 'google_places,fullenrich')
    .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}

async function providerRequest() {
  const errors: string[] = [];
  for (const provider of providerOrder()) {
    try {
      if (provider === 'google_places') {
        const result = await googlePlacesLeads(BATCH_SIZE);
        if (result.leads.length) {
          console.log('[acquisition-replenisher] provider=google_places leads=' + result.leads.length);
          return result;
        }
        errors.push('google_places: sem emails encontrados');
      } else if (provider === 'fullenrich') {
        if (Date.now() < fullEnrichCooldownUntil) {
          errors.push('fullenrich: cooldown');
          continue;
        }
        try {
          const result = await fullEnrichProvider();
          if (result.leads.length) {
            console.log('[acquisition-replenisher] provider=fullenrich leads=' + result.leads.length);
            return result;
          }
          errors.push('fullenrich: sem leads');
        } catch (error: any) {
          const message = clean(error?.message || error, 500);
          if (/HTTP 403|not enough credits|insufficient credits|credit/i.test(message)) {
            fullEnrichCooldownUntil = Date.now() + 6 * 60 * 60 * 1000;
            console.warn('[acquisition-replenisher] provider=fullenrich indisponível; cooldown de 6h');
          } else {
            console.warn('[acquisition-replenisher] provider=fullenrich falhou:', message);
          }
          errors.push(`fullenrich: ${message}`);
        }
      }
    } catch (error: any) {
      const message = clean(error?.message || error, 500);
      errors.push(`${provider}: ${message}`);
      console.warn(`[acquisition-replenisher] provider=${provider} falhou: ${message}`);
    }
  }
  throw new Error(`nenhum provider de aquisição disponível: ${errors.join(' | ')}`);
}

export async function replenishAcquisitionStock(force = false) {
  if (running) return { imported: 0, skipped: 0, reason: 'already_running' };
  running = true;
  try {
    const db = getDb();
    await ensureAcquisitionEngineSchema(db);
    const row = await db.get(`SELECT COUNT(*) AS c FROM leads
      WHERE acquisition_eligible=1 AND COALESCE(acquisition_suppressed,0)=0
      AND email IS NOT NULL AND TRIM(email)!=''
      AND acquisition_stage IN ('eligible','ready','followup')
      AND (acquisition_next_at IS NULL OR acquisition_next_at<=CURRENT_TIMESTAMP)`);
    const stock = Number(row?.c || 0);
    if (!force && stock >= MIN_STOCK) return { imported: 0, skipped: 0, reason: 'stock_ok', stock, min_stock: MIN_STOCK };

    const result = await providerRequest();
    let imported = 0, skipped = 0;
    for (const lead of result.leads) {
      const email = clean(lead?.email, 320).toLowerCase();
      if (!validEmail(email)) { skipped++; continue; }
      const exists = await db.get('SELECT id FROM leads WHERE LOWER(email)=? LIMIT 1', [email]);
      if (exists) { skipped++; continue; }
      const id = clean(lead?.id, 180) || `provider-${hash(email).slice(0, 32)}`;
      try {
        await db.run(`INSERT INTO leads
          (id,nome_empresa,email,fonte,raw_json,criado_em,acquisition_eligible,acquisition_suppressed,acquisition_stage,acquisition_next_at,acquisition_source,acquisition_timezone)
          VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,1,0,'eligible',CURRENT_TIMESTAMP,?,?)`,
          [id, clean(lead?.company || lead?.nome_empresa, 180) || null, email,
           clean(lead?.source, 120) || 'acquisition', JSON.stringify(lead?.profile || lead).slice(0, 20000),
           clean(lead?.source, 120) || 'acquisition', clean(lead?.timezone, 120) || null]);
        imported++;
      } catch (e: any) {
        if (/duplicate|unique|constraint/i.test(String(e?.message || e))) skipped++;
        else throw e;
      }
    }
    return { imported, skipped, provider_returned: result.leads.length, stock, min_stock: MIN_STOCK };
  } finally {
    running = false;
  }
}

export function startAcquisitionReplenisher() {
  if (started || process.env.ACQUISITION_REPLENISHER !== '1') return;
  started = true;
  const tick = () => replenishAcquisitionStock()
    .then(r => console.log('[acquisition-replenisher]', r))
    .catch(e => console.warn('[acquisition-replenisher]', e?.message || e));
  tick();
  setInterval(tick, INTERVAL_MS);
}
