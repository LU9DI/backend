import { getDb } from './db.js';

const ENABLED = process.env.PRODUCT_HUNT_ACQUISITION_ENABLED === '1';
const INTERVAL_MS = Math.max(15 * 60_000, Number(process.env.PRODUCT_HUNT_ACQUISITION_INTERVAL_MS || 60 * 60_000));
const BATCH_SIZE = Math.max(1, Math.min(50, Number(process.env.PRODUCT_HUNT_ACQUISITION_BATCH_SIZE || 20)));
const TOKEN = () => (process.env.PRODUCT_HUNT_ACCESS_TOKEN || '').trim();
const COMMERCIAL_APPROVED = () => process.env.PRODUCT_HUNT_COMMERCIAL_APPROVED === '1';
const WEBSITE_TIMEOUT_MS = Math.max(5000, Number(process.env.PRODUCT_HUNT_WEBSITE_TIMEOUT_MS || 12000));
const CONTACT_RE = /(?:contact|contato|contacto|fale|sales|commercial|business|partnership|support|about)/i;

let started = false;
let running = false;

const clean = (v: unknown, n = 5000) => String(v ?? '').trim().slice(0, n);
const validUrl = (v: unknown) => {
  try { const u = new URL(clean(v, 2000)); return /^https?:$/.test(u.protocol) ? u.toString() : null; }
  catch { return null; }
};

type ProductHuntPost = {
  id: string;
  name: string;
  tagline?: string;
  description?: string;
  website?: string;
  url?: string;
  votesCount?: number;
  commentsCount?: number;
  createdAt?: string;
  topics?: { nodes?: Array<{ name?: string; slug?: string }> };
  makers?: { nodes?: Array<{ name?: string; username?: string }> };
};

async function ensureSchema() {
  const db = getDb();
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_leads_product_hunt
      ON leads(acquisition_source, created_at)
  `);
}

function scorePost(post: ProductHuntPost): number {
  const votes = Number(post.votesCount || 0);
  const comments = Number(post.commentsCount || 0);
  const hasSite = !!validUrl(post.website);
  // Discovery score only: it is not a claim about quality or business performance.
  return Math.min(100, 25 + Math.min(votes, 50) + Math.min(comments * 2, 20) + (hasSite ? 5 : 0));
}

async function fetchPosts(): Promise<ProductHuntPost[]> {
  const token = TOKEN();
  if (!token) throw new Error('PRODUCT_HUNT_ACCESS_TOKEN ausente');
  if (!COMMERCIAL_APPROVED()) {
    throw new Error('PRODUCT_HUNT_COMMERCIAL_APPROVED=1 necessário: a API informa que uso comercial exige contato/aprovação do Product Hunt');
  }

  const query = `
    query FiltraAcquisition($first: Int!) {
      posts(first: $first, order: NEWEST) {
        edges {
          node {
            id
            name
            tagline
            description
            website
            url
            votesCount
            commentsCount
            createdAt
            topics { nodes { name slug } }
            makers { nodes { name username } }
          }
        }
      }
    }
  `;

  const response = await fetch('https://api.producthunt.com/v2/api/graphql', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables: { first: BATCH_SIZE } }),
  });

  const body: any = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) {
    throw new Error(clean(body.errors?.[0]?.message || `Product Hunt HTTP ${response.status}`, 500));
  }
  return (body.data?.posts?.edges || []).map((x: any) => x.node).filter((x: any) => x?.id && x?.name);
}

async function inspectOfficialWebsite(website: string) {
  const result = { website, contact_urls: [] as string[], emails: [] as string[] };
  if (!website) return result;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBSITE_TIMEOUT_MS);
  try {
    const response = await fetch(website, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'FiltraAI-Acquisition/1.0 (+https://filtraai.com)' },
    });
    if (!response.ok) return result;
    const html = (await response.text()).slice(0, 400000);
    const base = validUrl(response.url) || website;
    const host = new URL(base).hostname;
    for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\\s\\S]*?)<\\/a>/gi)) {
      const href = clean(match[1], 2000);
      const text = clean(match[2].replace(/<[^>]+>/g, ' '), 500);
      if (!CONTACT_RE.test(href) && !CONTACT_RE.test(text)) continue;
      try {
        const url = new URL(href, base);
        if (/^https?:$/.test(url.protocol) && url.hostname === host) result.contact_urls.push(url.toString());
      } catch {}
    }
    const matches = html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi) || [];
    result.emails = [...new Set(matches.map(x => x.toLowerCase()).filter(x => !/example\\.|sentry|wix|wordpress/i.test(x)))].slice(0, 10);
    result.contact_urls = [...new Set(result.contact_urls)].slice(0, 5);
  } catch {
    // Best effort: the browser adapter can still use the official website.
  } finally {
    clearTimeout(timer);
  }
  return result;
}

async function upsertPost(post: ProductHuntPost): Promise<boolean> {
  const db = getDb();
  const website = validUrl(post.website);
  const mapsUrl = validUrl(post.url);
  const websiteInfo = website ? await inspectOfficialWebsite(website) : { website: '', contact_urls: [] as string[], emails: [] as string[] };
  const raw = JSON.stringify({ source: 'product_hunt', fetched_at: new Date().toISOString(), website: websiteInfo.website || '', contact_urls: websiteInfo.contact_urls, emails: websiteInfo.emails, post });
  const company = clean(post.name, 300);
  const source = websiteInfo.website ? 'Product Hunt + official website' : 'product_hunt';
  const segment = 'startup_product';
  const score = scorePost(post);
  const qualification = score >= 55 ? 'prospect' : 'prospect';

  const existing = await db.get<{ id: any }>(
    `SELECT id FROM leads WHERE acquisition_source = ? AND raw_json::text LIKE ? LIMIT 1`,
    [source, `%"id":"${String(post.id).replace(/"/g, '')}"%`]
  );
  if (existing) return false;

  await db.run(
    `INSERT INTO leads (
      nome_empresa, email, telefone, score, qualification, ai_reason,
      fonte, maps_url, raw_json, criado_em, crm_status,
      acquisition_eligible, acquisition_suppressed, acquisition_stage,
      acquisition_source, acquisition_segment
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'pending', 1, 0, 'eligible', ?, ?)`,
    [
      company,
      websiteInfo.emails[0] || null,
      null,
      score,
      qualification,
      clean(`Product Hunt launch: ${post.tagline || post.description || 'recent product discovery'}`, 1000),
      'Product Hunt',
      mapsUrl || website,
      raw,
      source,
      segment,
    ],
  );
  return true;
}

export async function runProductHuntAcquisitionOnce(): Promise<{ ok: boolean; fetched: number; inserted: number; error?: string }> {
  if (running) return { ok: true, fetched: 0, inserted: 0 };
  running = true;
  try {
    await ensureSchema();
    const posts = await fetchPosts();
    let inserted = 0;
    for (const post of posts) {
      if (await upsertPost(post)) inserted++;
    }
    console.log(`[product-hunt-acquisition] fetched=${posts.length} inserted=${inserted}`);
    return { ok: true, fetched: posts.length, inserted };
  } catch (e: any) {
    const error = clean(e?.message || e, 1000);
    console.warn(`[product-hunt-acquisition] skipped/error: ${error}`);
    return { ok: false, fetched: 0, inserted: 0, error };
  } finally {
    running = false;
  }
}

export async function startProductHuntAcquisition() {
  if (started || !ENABLED) return;
  started = true;
  await runProductHuntAcquisitionOnce();
  setInterval(() => void runProductHuntAcquisitionOnce(), INTERVAL_MS);
  console.log(`[product-hunt-acquisition] enabled; interval=${INTERVAL_MS}ms batch=${BATCH_SIZE}`);
}
