import { getDb } from './db.js';
import { ensureAcquisitionEngineSchema } from './acquisitionEngine.js';
import { googlePlacesLeads } from './acquisitionGooglePlaces.js';
import crypto from 'crypto';

const MIN_STOCK = Math.max(80, Number(process.env.ACQUISITION_MIN_STOCK || 560));
const BATCH_SIZE = Math.min(200, Math.max(1, Number(process.env.ACQUISITION_REPLENISH_BATCH || 200)));
const INTERVAL_MS = Math.max(60000, Number(process.env.ACQUISITION_REPLENISH_INTERVAL_MS || 600000));
const FULLENRICH_BASE = 'https://app.fullenrich.com/api/v2';

let running = false;
let started = false;
let fullEnrichCooldownUntil = 0;

const clean = (v: unknown, n = 5000) => String(v ?? '').trim().slice(0, n);
const validEmail = (v: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(v, 320));
const institutionalKeywords = /(associa[cç][aã]o|associacao|sindicato|federa[cç][aã]o|federacao|c[aâ]mara de com[eé]rcio|camara de comercio|entidade empresarial|uni[aã]o empresarial|conselho empresarial|instituto empresarial|confedera[cç][aã]o|confederacao)/i;
function acquisitionSegment(lead: any) {
  const category = clean(lead?.profile?.category || lead?.profile?.types?.join?.(' ') || '', 1000);
  const haystack = [lead?.company, lead?.source, category, JSON.stringify(lead?.profile || {})].join(' ');
  return institutionalKeywords.test(haystack) || /trade_union|association|chamber|non_profit/i.test(haystack) ? 'institutional' : 'business';
}
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


const OSM_URL = clean(process.env.ACQUISITION_OSM_OVERPASS_URL, 2000) || 'https://overpass-api.de/api/interpreter';
const OSM_TARGET_TYPES = /(hotel|hostel|guest_house|restaurant|cafe|bar|clinic|doctors|dentist|pharmacy|beauty|hairdresser|car_dealer|car_repair|retail|shop|supermarket|school|college|university|tourism|association|trade_union|chamber|non_profit|office)/i;
const OSM_EXCLUDED_OFFICES = /^(government|governmental|embassy|consulate|city_hall|courthouse|police|fire_station|military|public_service|administrative)$/i;

const OSM_CITIES = [
  ['São Paulo', -23.82, -46.82, -23.35, -46.35],
  ['Rio de Janeiro', -23.05, -43.80, -22.70, -43.05],
  ['Belo Horizonte', -20.05, -44.15, -19.75, -43.80],
  ['Curitiba', -25.65, -49.45, -25.30, -49.10],
  ['Goiânia', -17.00, -49.50, -16.50, -49.00],
] as const;

function osmEmail(tags: any) {
  const value = clean(tags?.email || tags?.['contact:email'], 320).toLowerCase();
  return validEmail(value) ? value : '';
}
function osmWebsite(tags: any) {
  return clean(tags?.website || tags?.['contact:website'], 1000);
}
function osmQuery(city: typeof OSM_CITIES[number]) {
  const [name, south, west, north, east] = city;
  const bbox = `${south},${west},${north},${east}`;
  // Restrict discovery to objects that already expose a public email or official website.
  return `[out:json][timeout:30];(\n    nwr["email"](${bbox});\n    nwr["contact:email"](${bbox});\n    nwr["website"](${bbox});\n    nwr["contact:website"](${bbox});\n  );out center tags;`;
}
async function osmWebsiteEmails(url: string) {
  try {
    const base = new URL(url);
    const paths = ['', '/contato', '/contact'];
    const found = new Set<string>();
    for (const path of paths) {
      const response = await fetch(new URL(path || '/', base), {
        headers: { 'user-agent': 'FiltraAI-Acquisition/1.0 (+https://filtraai.com)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok || !(response.headers.get('content-type') || '').includes('text/html')) continue;
      const html = (await response.text()).slice(0, 400000)
        .replace(/&#64;|\[at\]|\(at\)/gi, '@')
        .replace(/&#46;|\[dot\]|\(dot\)/gi, '.');
      for (const email of html.match(/[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/g) || []) {
        const e = email.toLowerCase();
        if (validEmail(e)) found.add(e);
      }
      if (found.size >= 3) break;
    }
    return [...found].slice(0, 5);
  } catch { return []; }
}
async function openStreetMapProvider(limit: number) {
  const target = Math.min(200, Math.max(1, limit));
  const elements: any[] = [];
  for (const city of OSM_CITIES) {
    try {
      const response = await fetch(OSM_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'FiltraAI-Acquisition/1.0 (+https://filtraai.com)',
        },
        body: 'data=' + encodeURIComponent(osmQuery(city)),
        signal: AbortSignal.timeout(75000),
      });
      if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
      const data: any = await response.json();
      for (const element of Array.isArray(data?.elements) ? data.elements : []) {
        const tags = element?.tags || {};
        const category = [tags.office, tags.amenity, tags.tourism, tags.shop, tags.healthcare, tags.craft, tags.leisure].filter(Boolean).join(' ');
        const relevant = OSM_TARGET_TYPES.test(category);
        const office = clean(tags?.office, 120);
        const excludedOffice = OSM_EXCLUDED_OFFICES.test(office);
        if (tags?.name && relevant && !excludedOffice && (osmWebsite(tags) || osmEmail(tags))) elements.push({ element, city });
      }
      console.log(`[acquisition-osm] city=${city[0]} elements=${data?.elements?.length || 0}`);
      if (elements.length >= target * 3) break;
    } catch (error: any) {
      console.warn(`[acquisition-osm] city=${city[0]} failed:`, error?.message || error);
    }
  }
  const ranked = elements.sort((a,b) => {
    const score = (x:any) => {
      const t=x?.element?.tags||{}, o=String(t.office||'').toLowerCase();
      return (['association','trade_union','chamber','chamber_of_commerce','non_profit'].includes(o)?8:0)
        +(t.tourism==='hotel'?5:0)+(t.amenity==='restaurant'||t.amenity==='clinic'||t.amenity==='doctors'?3:0)
        +(osmWebsite(t)?3:0)+(osmEmail(t)?10:0);
    };
    return score(b)-score(a);
  }).slice(0,target*2);
  const leads:any[]=[]; const seen=new Set<string>();
  const direct = ranked.filter(({element}: any) => Boolean(osmEmail(element?.tags || {}))).slice(0, target);
  const website = ranked.filter(({element}: any) => !osmEmail(element?.tags || {}) && Boolean(osmWebsite(element?.tags || {}))).slice(0, 24);
  const candidates = [...direct, ...website];
  for(let i=0;i<candidates.length && leads.length<target;i+=8){
    const results=await Promise.all(candidates.slice(i,i+8).map(async ({element,city})=>{
      const t=element?.tags||{}; let emails:string[]=[];
      const direct=osmEmail(t); if(direct) emails=[direct];
      else if(osmWebsite(t)) emails=await osmWebsiteEmails(osmWebsite(t));
      return {element,city,emails};
    }));
    for(const {element,city,emails} of results) for(const email of emails){
      if(seen.has(email)) continue; seen.add(email);
      const t=element?.tags||{}, website=osmWebsite(t);
      leads.push({
        id:`osm-${crypto.createHash('sha256').update(email).digest('hex').slice(0,32)}`,
        email,
        company:clean(t?.name||city[0],200),
        source:'OpenStreetMap + official website',
        timezone:'America/Sao_Paulo',
        profile:{provider:'openstreetmap_overpass',osm_id:`${element?.type}:${element?.id}`,category:clean(t?.office||t?.amenity||t?.tourism,100),address:clean([t?.['addr:street'],t?.['addr:housenumber'],t?.['addr:city']||city[0],t?.['addr:state']].filter(Boolean).join(', '),500),website},
      });
      if(leads.length>=target) break;
    }
  }
  console.log(`[acquisition-osm] done leads=${leads.length}`);
  return {leads};
}

function providerOrder() {
  return clean(process.env.ACQUISITION_PROVIDERS || 'osm,google_places,fullenrich')
    .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}

async function providerRequest(db: any) {
  const errors: string[] = [];
  for (const provider of providerOrder()) {
    try {
      if (provider === 'osm') {
        const result = await openStreetMapProvider(BATCH_SIZE);
        const fresh: any[] = [];
        for (const lead of result.leads) {
          const email = clean(lead?.email, 320).toLowerCase();
          if (!validEmail(email)) continue;
          const exists = await db.get('SELECT id FROM leads WHERE LOWER(email)=? LIMIT 1', [email]);
          if (!exists) fresh.push(lead);
        }
        if (fresh.length) {
          console.log('[acquisition-replenisher] provider=osm fresh=' + fresh.length + ' returned=' + result.leads.length);
          return { leads: fresh };
        }
        errors.push('osm: somente leads já existentes');
      } else if (provider === 'google_places') {
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
    // Existing acquisition stock predates the browser queue and may have NULL browser_status.
    // Backfill only eligible public-prospect/opted-in leads that expose a public website.
    const queuedExisting = await db.run(`UPDATE leads SET browser_status='pending'
      WHERE acquisition_eligible=1 AND COALESCE(acquisition_suppressed,0)=0
        AND (acquisition_opted_in_at IS NOT NULL OR acquisition_contact_basis='b2b_public_prospect')
        AND browser_status IS NULL
        AND (NULLIF(BTRIM(COALESCE(raw_json::jsonb->>'website','')), '') IS NOT NULL
          OR NULLIF(BTRIM(COALESCE(raw_json::jsonb->>'websiteUri','')), '') IS NOT NULL
          OR NULLIF(BTRIM(COALESCE(raw_json::jsonb->'profile'->>'website','')), '') IS NOT NULL
          OR NULLIF(BTRIM(COALESCE(raw_json::jsonb->'profile'->>'websiteUri','')), '') IS NOT NULL)`);
    if (Number(queuedExisting?.changes || 0) > 0) {
      console.log('[acquisition-replenisher] browser_queue_backfill=' + Number(queuedExisting.changes || 0));
    }
    const row = await db.get(`SELECT COUNT(*) AS c FROM leads
      WHERE acquisition_eligible=1 AND COALESCE(acquisition_suppressed,0)=0
      AND email IS NOT NULL AND TRIM(email)!=''
      AND acquisition_stage IN ('eligible','ready','followup')
      AND (acquisition_next_at IS NULL OR acquisition_next_at<=CURRENT_TIMESTAMP)
      AND (browser_status IS NULL OR browser_status='pending')
      AND (
        NULLIF(BTRIM(COALESCE(raw_json::jsonb->>'website','')), '') IS NOT NULL
        OR NULLIF(BTRIM(COALESCE(raw_json::jsonb->>'websiteUri','')), '') IS NOT NULL
        OR NULLIF(BTRIM(COALESCE(raw_json::jsonb->'profile'->>'website','')), '') IS NOT NULL
        OR NULLIF(BTRIM(COALESCE(raw_json::jsonb->'profile'->>'websiteUri','')), '') IS NOT NULL
      )`);
    const stock = Number(row?.c || 0);
    if (!force && stock >= MIN_STOCK) return { imported: 0, skipped: 0, reason: 'stock_ok', stock, min_stock: MIN_STOCK };

    const result = await providerRequest(db);
    let imported = 0, skipped = 0;
    for (const lead of result.leads) {
      const email = clean(lead?.email, 320).toLowerCase();
      if (!validEmail(email)) { skipped++; continue; }
      const exists = await db.get('SELECT id FROM leads WHERE LOWER(email)=? LIMIT 1', [email]);
      if (exists) { skipped++; continue; }
      const id = clean(lead?.id, 180) || `provider-${hash(email).slice(0, 32)}`;
      try {
        await db.run(`INSERT INTO leads
          (id,nome_empresa,email,fonte,raw_json,criado_em,acquisition_eligible,acquisition_suppressed,acquisition_stage,acquisition_next_at,acquisition_source,acquisition_timezone,acquisition_segment,acquisition_contact_basis,browser_status)
          VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,1,0,'eligible',CURRENT_TIMESTAMP,?,?,?,'b2b_public_prospect','pending')`,
          [id, clean(lead?.company || lead?.nome_empresa, 180) || null, email,
           clean(lead?.source, 120) || 'acquisition', JSON.stringify(lead?.profile || lead).slice(0, 20000),
           clean(lead?.source, 120) || 'acquisition', clean(lead?.timezone, 120) || null, acquisitionSegment(lead)]);
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
  // O replenisher faz parte do motor de aquisição. Se o motor estiver
  // habilitado, a descoberta de leads não pode ficar parada só porque a
  // variável específica do replenisher não foi criada no Render.
  const enabled =
    process.env.ACQUISITION_REPLENISHER === '1' ||
    process.env.ACQUISITION_ENGINE === '1';
  if (started || !enabled) return;
  started = true;
  const tick = () => replenishAcquisitionStock()
    .then(r => console.log('[acquisition-replenisher]', r))
    .catch(e => console.warn('[acquisition-replenisher]', e?.message || e));
  tick();
  setInterval(tick, INTERVAL_MS);
}
