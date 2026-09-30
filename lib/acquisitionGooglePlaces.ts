import crypto from 'crypto';

const clean = (v: unknown, n = 5000) => String(v ?? '').trim().slice(0, n);
const validEmail = (v: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(v, 320));
const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

const defaultQueries = [
  'hotéis em São Paulo SP',
  'clínicas em São Paulo SP',
  'restaurantes em São Paulo SP',
  'agências de marketing em São Paulo SP',
  'hotéis no Rio de Janeiro RJ',
  'clínicas no Rio de Janeiro RJ',
  'restaurantes em Belo Horizonte MG',
  'clínicas em Curitiba PR',
  'associação empresarial no Brasil',
  'sindicato empresarial no Brasil',
  'federação empresarial no Brasil',
  'câmara de comércio no Brasil',
];

const contactPaths = [
  '',
  '/contato',
  '/contact',
  '/fale-conosco',
  '/faleconosco',
  '/sobre',
  '/about',
];

function placesKey() {
  return clean(process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_API_KEY, 1000);
}

function queries() {
  const raw = clean(process.env.GOOGLE_PLACES_QUERIES, 10000);
  return (raw ? raw.split('|') : defaultQueries).map(x => x.trim()).filter(Boolean);
}

function timezoneFromAddress(address: string) {
  const a = address.toLowerCase();
  if (/brasil|sp|rio de janeiro|minas gerais|paraná|goiás|bahia|ceará/.test(a)) return 'America/Sao_Paulo';
  if (/portugal/.test(a)) return 'Europe/Lisbon';
  if (/spain|españa|espanha/.test(a)) return 'Europe/Madrid';
  if (/mexico|méxico/.test(a)) return 'America/Mexico_City';
  if (/argentina/.test(a)) return 'America/Argentina/Buenos_Aires';
  if (/chile/.test(a)) return 'America/Santiago';
  if (/colombia|colômbia/.test(a)) return 'America/Bogota';
  return null;
}

async function searchPlaces(textQuery: string, pageToken?: string) {
  const key = placesKey();
  if (!key) throw new Error('Google Places API key ausente: configure GOOGLE_MAPS_API_KEY no Render');

  const body: any = {
    textQuery,
    languageCode: 'pt-BR',
    regionCode: 'BR',
    pageSize: 20,
  };
  if (pageToken) body.pageToken = pageToken;

  // Places API (New): mantém FieldMask explícita para limitar resposta/custo.
  const fieldMask =
    'places.id,places.displayName,places.formattedAddress,places.websiteUri,places.rating,places.userRatingCount,places.types,nextPageToken';

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': key,
          'x-goog-fieldmask': fieldMask,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });

      const raw = await response.text();
      let data: any = {};
      try { data = JSON.parse(raw); } catch {}

      if (response.ok) return data;

      // 4xx é erro de configuração/permissão: não insistir e não gerar custo repetido.
      if (response.status < 500) {
        throw new Error(`Google Places HTTP ${response.status}: ${clean(data?.error?.message || raw, 500)}`);
      }

      // 5xx/transiente: backoff exponencial antes de nova tentativa.
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }

      throw new Error(`Google Places HTTP ${response.status}: ${clean(data?.error?.message || raw, 500)}`);
    } catch (error: any) {
      const message = String(error?.message || error);
      if (attempt >= 2 || /HTTP 4\\d\\d/.test(message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }

  throw new Error('Google Places: tentativas esgotadas');
}
function candidateScore(place: any) {
  const rating = Number(place?.rating || 0);
  const reviews = Number(place?.userRatingCount || 0);
  let score = 0;
  if (rating > 0 && rating <= 4.0) score += 3;
  if (rating > 0 && rating <= 4.3) score += 1;
  if (reviews <= 10) score += 3;
  else if (reviews <= 30) score += 2;
  else if (reviews <= 100) score += 1;
  if (place?.websiteUri) score += 2;
  return score;
}

async function readWebsite(url: string) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    const response = await fetch(parsed.toString(), {
      headers: { 'user-agent': 'FiltraAI-Acquisition/1.0 (+https://filtraai.com)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return '';
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html')) return '';
    return (await response.text()).slice(0, 600000);
  } catch {
    return '';
  }
}

function extractEmails(html: string) {
  const decoded = html
    .replace(/&#64;|\[at\]|\(at\)/gi, '@')
    .replace(/&#46;|\[dot\]|\(dot\)/gi, '.');
  const matches = decoded.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  const blocked = new Set(['example.com', 'example.org', 'sentry.io', 'wixpress.com']);
  return [...new Set(matches.map(x => x.toLowerCase()))]
    .filter(validEmail)
    .filter(x => !blocked.has(x.split('@')[1]))
    .filter(x => !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(x));
}

async function websiteEmails(url: string) {
  const base = new URL(url);
  const found = new Set<string>();
  for (const path of contactPaths) {
    const target = new URL(path || '/', base).toString();
    const html = await readWebsite(target);
    for (const email of extractEmails(html)) found.add(email);
    if (found.size >= 3) break;
  }
  return [...found].slice(0, 5);
}

export async function googlePlacesLeads(limit: number) {
  if (!placesKey()) throw new Error('Google Places API key ausente');
  const target = Math.min(200, Math.max(1, limit));
  const places = new Map<string, any>();

  const queryList = queries();
  console.log('[acquisition-google-places] start queries=' + queryList.length + ' target=' + target);
  for (let i = 0; i < queryList.length; i += 4) {
    if (places.size >= target * 2) break;
    const batch = queryList.slice(i, i + 4);
    const results = await Promise.all(batch.map(async (query) => {
      try {
        const first = await searchPlaces(query);
        const pages = [first];
        if (first?.nextPageToken) {
          await new Promise(resolve => setTimeout(resolve, 1200));
          pages.push(await searchPlaces(query, first.nextPageToken));
        }
        return pages;
      } catch (error: any) {
        console.warn('[acquisition-google-places] query=' + query + ' failed:', error?.message || error);
        return [];
      }
    }));
    for (const pages of results) {
      for (const page of pages) {
        for (const place of Array.isArray(page?.places) ? page.places : []) {
          const id = clean(place?.id, 300);
          if (id) places.set(id, place);
        }
      }
    }
    console.log('[acquisition-google-places] places=' + places.size);
  }

  const ranked = [...places.values()]
    .filter(p => p?.websiteUri)
    .sort((a, b) => candidateScore(b) - candidateScore(a))
    .slice(0, target * 2);

  const leads: any[] = [];
  for (let i = 0; i < ranked.length && leads.length < target; i += 8) {
    const batch = ranked.slice(i, i + 8);
    const emailResults = await Promise.all(batch.map(async (place) => {
      try {
        return { place, emails: await websiteEmails(place.websiteUri) };
      } catch {
        return { place, emails: [] as string[] };
      }
    }));
    for (const { place, emails } of emailResults) {
      for (const email of emails) {
        leads.push({
        id: `google-places-${hash(email).slice(0, 32)}`,
        email,
        company: clean(place?.displayName?.text, 200),
        source: 'Google Places + official website',
        timezone: timezoneFromAddress(clean(place?.formattedAddress, 500)),
        profile: {
          provider: 'google_places',
          place_id: clean(place?.id, 300),
          address: clean(place?.formattedAddress, 500),
          website: clean(place?.websiteUri, 1000),
          rating: Number(place?.rating || 0),
          review_count: Number(place?.userRatingCount || 0),
          types: Array.isArray(place?.types) ? place.types : [],
        },
      });
        if (leads.length >= target) break;
      }
      if (leads.length >= target) break;
    }
  }
  console.log('[acquisition-google-places] done places=' + places.size + ' leads=' + leads.length);
  return { leads };
}
