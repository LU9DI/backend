import crypto from 'crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { createRequire } from 'node:module';
import { getDb } from './db.js';

const require = createRequire(import.meta.url);

const ENABLED = process.env.ACQUISITION_BROWSER_BOT === '1';
const CHILD_MODE = process.env.ACQUISITION_BROWSER_CHILD === '1';
const INTERVAL_MS = Math.max(60_000, Number(process.env.ACQUISITION_BROWSER_INTERVAL_MS || 300_000));
const DAILY_CAP = Math.max(1, Math.min(30, Number(process.env.ACQUISITION_BROWSER_DAILY_CAP || 10)));
const CONCURRENCY = Math.max(1, Math.min(2, Number(process.env.ACQUISITION_BROWSER_CONCURRENCY || 1)));
const MAX_ATTEMPTS = 2;
let started = false;
let running = false;
let lastTriggeredAt = 0;

const clean = (v: unknown, n = 5000) => String(v ?? '').trim().slice(0, n);
const validUrl = (v: unknown) => {
  try { const u = new URL(clean(v, 2000)); return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; }
};

function normalizePublicPhones(values: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = clean(raw, 160).replace(/\s+/g, ' ').trim();
    const digits = value.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) continue;
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) continue;
    if (/\b(?:cep|zip|postal|c[oó]digo|code|id|cnpj|cpf)\b/i.test(value)) continue;
    const national = digits.length === 11 && /^[1-9][1-9][6-9]\d{8}$/.test(digits);
    const landline = digits.length === 10 && /^[1-9][1-9][2-5]\d{7}$/.test(digits);
    const international = digits.length >= 12 && digits.length <= 15 && /^(?:55|1|2|3|4|5|6|7|8|9)/.test(digits);
    if (!national && !landline && !international) continue;
    const key = digits.replace(/^00/, '+');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= 5) break;
  }
  return out;
}

function normalizePublicChannels(values: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = clean(raw, 500);
    if (!value) continue;
    let key = value.toLowerCase();
    try {
      const u = new URL(value);
      if (/^(?:wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)$/i.test(u.hostname)) {
        const phone = u.searchParams.get('phone') || u.pathname.replace(/^\/+/, '');
        const digits = phone.replace(/\D/g, '');
        if (digits.length < 10 || digits.length > 15) continue;
        key = 'whatsapp:' + digits;
      } else if (/^tel:/i.test(value)) {
        const digits = value.replace(/\D/g, '');
        if (digits.length < 8 || digits.length > 15) continue;
        key = 'tel:' + digits;
      } else if (/^mailto:/i.test(value)) {
        key = 'mailto:' + value.slice(7).split('?')[0].trim().toLowerCase();
      }
    } catch {}
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= 10) break;
  }
  return out;
}

function detectLanguage(html: string, url: URL) {
  const lang = (html.match(/<html[^>]+lang=["']([^"']+)["']/i)?.[1] || '').toLowerCase();
  if (lang.startsWith('pt')) return 'pt';
  if (lang.startsWith('es')) return 'es';
  if (lang.startsWith('fr')) return 'fr';
  if (lang.startsWith('de')) return 'de';
  if (lang.startsWith('it')) return 'it';
  if (/\.(pt|br)(?:$|\/)/i.test(url.hostname + url.pathname)) return 'pt';
  if (/\.(es|mx|ar|cl|co)(?:$|\/)/i.test(url.hostname + url.pathname)) return 'es';
  return 'en';
}

function message(lang: string, company: string) {
  const c = company || 'your company';
  const common = {
    pt: {
      subject: `Auditoria gratuita de reputação — ${c}`,
      body: `Olá, equipe ${c}.

A Filtra.AI ajuda empresas a transformar avaliações e feedback dos clientes em ações para melhorar reputação, experiência e crescimento.

Gostaríamos de oferecer uma auditoria gratuita da reputação online da ${c}, sem compromisso. O resultado mostra pontos de atenção nas avaliações e oportunidades práticas de melhoria.

A auditoria está disponível em https://filtraai.com/auditoria-gratuita

Equipe Filtra.AI`,
    },
    es: {
      subject: `Auditoría gratuita de reputación — ${c}`,
      body: `Hola, equipo de ${c}.

Filtra.AI ayuda a las empresas a convertir las reseñas y comentarios de clientes en acciones para mejorar reputación, experiencia y crecimiento.

Nos gustaría ofrecer una auditoría gratuita de la reputación online de ${c}, sin compromiso. El resultado muestra puntos de atención y oportunidades prácticas de mejora.

La auditoría está disponible en https://filtraai.com/auditoria-gratuita

Equipo Filtra.AI`,
    },
    fr: {
      subject: `Audit gratuit de réputation — ${c}`,
      body: `Bonjour, équipe ${c}.

Filtra.AI aide les entreprises à transformer les avis clients en actions concrètes pour améliorer leur réputation, leur expérience client et leur croissance.

Nous proposons un audit gratuit de la réputation en ligne de ${c}, sans engagement.

L’audit est disponible sur https://filtraai.com/auditoria-gratuita

Équipe Filtra.AI`,
    },
    de: {
      subject: `Kostenloser Reputations-Audit — ${c}`,
      body: `Hallo ${c}-Team,

Filtra.AI hilft Unternehmen, Kundenbewertungen und Feedback in konkrete Maßnahmen für Reputation, Kundenerlebnis und Wachstum umzuwandeln.

Wir bieten ${c} einen kostenlosen, unverbindlichen Audit der Online-Reputation an.

Der Audit ist verfügbar unter https://filtraai.com/auditoria-gratuita

Filtra.AI Team`,
    },
    it: {
      subject: `Audit gratuito della reputazione — ${c}`,
      body: `Buongiorno team ${c}.

Filtra.AI aiuta le aziende a trasformare recensioni e feedback dei clienti in azioni concrete per migliorare reputazione, esperienza e crescita.

Vorremmo offrire a ${c} un audit gratuito della reputazione online, senza impegno.

Audit: https://filtraai.com/auditoria-gratuita

Team Filtra.AI`,
    },
    en: {
      subject: `Free reputation audit — ${c}`,
      body: `Hello ${c} team,

Filtra.AI helps businesses turn customer reviews and feedback into practical actions to improve reputation, customer experience and growth.

We would like to offer ${c} a free, no-obligation online reputation audit. It highlights review trends, attention points and practical improvement opportunities.

Audit: https://filtraai.com/auditoria-gratuita

Filtra.AI Team`,
    },
  } as const;
  return common[lang as keyof typeof common] || common.en;
}

function extractWebsite(raw: string) {
  try {
    const obj = JSON.parse(raw || '{}');
    const candidates = [
      obj?.website, obj?.websiteUri, obj?.url,
      obj?.profile?.website, obj?.profile?.websiteUri, obj?.profile?.contact?.website,
      obj?.contact?.website
    ];
    return candidates.map((v:any) => clean(v,2000)).find((v:string) => !!validUrl(v)) || '';
  } catch { return ''; }
}

async function ensureSchema(db: any) {
  const columns = [
    ['browser_status', `TEXT NOT NULL DEFAULT 'pending'`],
    ['browser_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['browser_next_at', 'TIMESTAMPTZ'],
    ['browser_last_at', 'TIMESTAMPTZ'],
    ['browser_last_result', 'TEXT'],
    ['browser_channel', 'TEXT'],
    ['browser_channel_data', 'TEXT'],
    ['acquisition_contact_basis', 'TEXT'],
  ];
  for (const [name, type] of columns) {
    try { await db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${type}`); } catch {}
  }
  await db.exec('CREATE INDEX IF NOT EXISTS idx_browser_acq ON leads(browser_status,browser_next_at)');
  // Legacy repair: only restore provenance that is explicit in the stored source.
  // OpenStreetMap + official website is a public-prospect discovery source; do not
  // infer this basis for generic prospecting providers. Existing Resend-originated
  // rows are explicitly suppressed because Resend is not a cold-prospect source.
  await db.run(`UPDATE leads SET acquisition_contact_basis='b2b_public_prospect'
    WHERE acquisition_eligible=1 AND COALESCE(acquisition_suppressed,0)=0
      AND acquisition_opted_in_at IS NULL AND acquisition_contact_basis IS NULL
      AND BTRIM(COALESCE(acquisition_source, fonte, ''))='OpenStreetMap + official website'`);
  await db.run(`UPDATE leads SET acquisition_suppressed=1, acquisition_stage='suppressed', acquisition_next_at=NULL
    WHERE COALESCE(acquisition_suppressed,0)=0
      AND BTRIM(COALESCE(acquisition_source, fonte, ''))='resend_existing'
      AND acquisition_opted_in_at IS NULL`);
}

async function sentToday(db: any) {
  const row = await db.get(
    `SELECT COUNT(*) AS c FROM leads
      WHERE browser_status IN ('sent','contact_attempted')
        AND browser_last_at >= date_trunc('day', CURRENT_TIMESTAMP)`
  );
  return Number(row?.c || 0);
}

async function getCandidates(db: any, batchSize = 2) {
  await db.run(`UPDATE leads SET browser_status='pending' WHERE browser_status='processing' AND browser_last_at < CURRENT_TIMESTAMP - INTERVAL '10 minutes'`);
  return db.all(`WITH candidates AS (
       SELECT id FROM leads
        WHERE acquisition_eligible=1 AND COALESCE(acquisition_suppressed,0)=0
          AND (acquisition_opted_in_at IS NOT NULL OR acquisition_contact_basis = 'b2b_public_prospect')
          AND browser_status IN ('pending','contact_attempted','channel_found')
          AND COALESCE(browser_attempts,0) < ?
          AND (browser_next_at IS NULL OR browser_next_at <= CURRENT_TIMESTAMP)
          AND (NULLIF(BTRIM(COALESCE(raw_json::jsonb->>'website','')), '') IS NOT NULL
            OR NULLIF(BTRIM(COALESCE(raw_json::jsonb->>'websiteUri','')), '') IS NOT NULL
            OR NULLIF(BTRIM(COALESCE(raw_json::jsonb->'profile'->>'website','')), '') IS NOT NULL
            OR NULLIF(BTRIM(COALESCE(raw_json::jsonb->'profile'->>'websiteUri','')), '') IS NOT NULL)
        ORDER BY
          CASE browser_status
            WHEN 'channel_found' THEN 0
            WHEN 'pending' THEN 1
            WHEN 'contact_attempted' THEN 2
            ELSE 3
          END,
          CASE
            WHEN browser_last_result ILIKE '%ENOTFOUND%' THEN 9
            WHEN browser_last_result ILIKE '%unreachable%' THEN 9
            WHEN browser_last_result ILIKE '%site_no_contact_surface%' THEN 8
            WHEN browser_last_result ILIKE '%site_redirect_limit%' THEN 8
            WHEN browser_last_result ILIKE '%site_http_404%' THEN 8
            WHEN browser_last_result ILIKE '%site_http_410%' THEN 8
            WHEN browser_last_result ILIKE '%timeout%' THEN 7
            WHEN browser_last_result ILIKE '%site_http_5%' THEN 6
            ELSE 0
          END,
          CASE WHEN browser_attempts = 0 THEN 0 ELSE 1 END,
          criado_em ASC
        LIMIT ?)
      UPDATE leads l SET browser_status='processing', browser_last_at=CURRENT_TIMESTAMP
        FROM candidates c WHERE l.id=c.id
      RETURNING l.id,l.nome_empresa,l.email,l.raw_json,l.acquisition_source,l.acquisition_contact_basis,l.browser_attempts`, [MAX_ATTEMPTS, batchSize]);
}
function classifyChannel(channels: string[], phones: string[]) {
  if (channels.some(h => /(?:wa[.]me|whatsapp)/i.test(h))) return 'public_whatsapp';
  if (channels.some(h => /^tel:/i.test(h)) || phones.length) return 'public_phone';
  if (channels.some(h => /^mailto:/i.test(h))) return 'public_email';
  return 'public_contact_link';
}

function channelPayload(channels: string[], phones: string[]) {
  return {
    reason: 'manual_channel_available',
    channel: classifyChannel(channels, phones),
    channels: [...channels, ...phones].slice(0, 10),
  };
}

function isPrivateAddress(address: string) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') ||
      normalized.startsWith('::ffff:127.') || normalized.startsWith('::ffff:10.') ||
      normalized.startsWith('::ffff:192.168.');
  }
  return true;
}

async function assertPublicHost(url: URL) {
  const host = url.hostname;
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('site_private_host');
  }
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) {
    throw new Error('site_private_or_unresolvable_host');
  }
}

async function preflightWebsite(base: URL): Promise<URL> {
  let current = new URL(base.toString());
  const seen = new Set<string>();
  for (let hop = 0; hop < 5; hop += 1) {
    const key = current.toString();
    if (seen.has(key)) throw new Error('site_redirect_loop');
    seen.add(key);
    await assertPublicHost(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_500);
    try {
      const response = await fetch(current.toString(), {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'FiltraAI-Acquisition/1.0 (+https://filtraai.com)' },
      });
      if (response.status >= 500) throw new Error(`site_http_${response.status}`);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return current;
        const next = validUrl(new URL(location, current).toString());
        if (!next) throw new Error('site_redirect_invalid');
        current = next;
        continue;
      }
      return current;
    } catch (e: any) {
      const message = clean(e?.message || e, 300);
      if (/aborted|abort/i.test(message)) throw new Error('site_preflight_timeout_3s');
      if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ECONNRESET|fetch failed/i.test(message)) {
        throw new Error(`site_preflight_unreachable:${message}`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('site_redirect_limit_5hops');
}

async function inspectContactSurface(base: URL) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_500);
  try {
    const response = await fetch(base.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'FiltraAI-Acquisition/1.0 (+https://filtraai.com)' },
    });
    if (response.status >= 500) throw new Error(`site_http_${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new Error('site_non_html');
    const html = (await response.text()).slice(0, 300_000);
    const contactPattern = /(contact|contato|contacto|fale|fale-conosco|habla|kontakt|contatti|comercial|sales|business|partnership|support|atendimento|suporte)/i;
    const captchaPattern = /(captcha|recaptcha|hcaptcha|turnstile)/i;
    const forms = html.match(/<form\b[\s\S]{0,16000}?<\/form>/gi) || [];
    const safeForm = forms.some(form => !captchaPattern.test(form) && /(?:<textarea\b|name=["'][^"']*(?:message|mensagem|mensaje|comments?|inquiry|enquiry|consulta|request)[^"']*["']|id=["'][^"']*(?:message|mensagem|mensaje|comments?|inquiry|enquiry|consulta|request)[^"']*["'])/i.test(form));
    const anyForm = forms.length > 0;
    const captchaForm = anyForm && !safeForm && forms.some(form => captchaPattern.test(form));
    const hrefs = [...html.matchAll(/(?:href|data-href)=["']([^"']+)["']/gi)].map(m => m[1]);
    let channels = normalizePublicChannels(hrefs.filter(h => /^(mailto:|tel:)/i.test(h) || /(?:wa\.me|api\.whatsapp\.com|whatsapp\.com\/send)/i.test(h)));
    const contactLinks = hrefs
      .map(h => { try { return new URL(h, base); } catch { return null; } })
      .filter((u): u is URL => !!u)
      .filter(u => u.origin === base.origin)
      .filter(u => !/[.](?:css|js|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot)(?:$|[?#])/i.test(u.pathname))
      .filter(u => contactPattern.test(u.pathname) || contactPattern.test(u.search))
      .map(u => u.toString())
      .slice(0, 2);

    // Discover channels from the contact page with a cheap static fetch before
    // spending a Chromium cycle.
    for (const href of contactLinks) {
      if (channels.length >= 10) break;
      try {
        const response = await fetch(href, {
          method: 'GET',
          redirect: 'follow',
          signal: AbortSignal.timeout(2500),
          headers: { 'user-agent': 'FiltraAI-Acquisition/1.0 (+https://filtraai.com)' },
        });
        const type = response.headers.get('content-type') || '';
        if (!response.ok || !/text\/html|application\/xhtml\+xml/i.test(type)) continue;
        const contactHtml = (await response.text()).slice(0, 200_000);
        const contactHrefs = [...contactHtml.matchAll(/(?:href|data-href)=[\"']([^\"']+)[\"']/gi)].map(m => m[1]);
        const discovered = normalizePublicChannels(contactHrefs.filter(h =>
          /^(mailto:|tel:)/i.test(h) || /(?:wa\.me|api\.whatsapp\.com|whatsapp\.com\/send)/i.test(h)
        ));
        const emails = (contactHtml.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
          .filter(x => !/example\.|noreply@|no-reply@/i.test(x))
          .slice(0, 5)
          .map(x => `mailto:${x.toLowerCase()}`);
        channels = normalizePublicChannels([...channels, ...discovered, ...emails]);
        const contactPhones = normalizePublicPhones(contactHtml.match(/(?:\+\d[\d .()-]{7,}\d|\(\d{2}\)[ .-]?\d{4,5}[ .-]?\d{4}|\b\d{2}[ .-]?\d{4,5}[ .-]?\d{4}\b)/g) || []);
        channels = normalizePublicChannels([...channels, ...contactPhones]);
      } catch {}
    }
    const hasContactText = contactPattern.test(html);
    if (safeForm) return { kind: 'form' as const, channels, contactLinks };
    if (channels.length && !anyForm) return { kind: 'manual_channel' as const, channels, contactLinks };
    if (captchaForm) return { kind: 'captcha' as const, channels, contactLinks };
    if (contactLinks.length || hasContactText || anyForm) return { kind: 'contact_page' as const, channels, contactLinks };
    return { kind: 'none' as const, channels, contactLinks };
  } catch (e: any) {
    const message = clean(e?.message || e, 300);
    if (/aborted|abort/i.test(message)) throw new Error('site_static_timeout');
    if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ECONNRESET|fetch failed/i.test(message)) {
      throw new Error(`site_static_unreachable:${message}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function runOne(lead: any, signal?: AbortSignal) {
  const db = getDb();
  let browser: any = null;
  const website = extractWebsite(lead.raw_json);
  const base = validUrl(website);
  if (!base) throw new Error('site_oficial_ausente');

  // Cheap DNS/HTTP reachability check before launching Chromium.
  const reachableBase = await preflightWebsite(base);

  // Probe the rendered source cheaply before spending a Chromium cycle. This
  // never submits a form; it only identifies whether a contact surface exists.
  const surface = await inspectContactSurface(reachableBase);
  if (surface.kind === 'manual_channel' && surface.channels.length) {
    throw new Error(JSON.stringify(channelPayload(surface.channels, [])));
  }
  if (surface.kind === 'none') throw new Error('site_no_contact_surface');
  if (surface.kind === 'captcha') throw new Error('captcha_requer_intervencao');

  const puppeteer = require('puppeteer-core');
  browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    timeout: 12_000,
    signal,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('FiltraAI-Acquisition/1.0 (+https://filtraai.com)');
    await page.setViewport({ width: 1365, height: 900 });
    const staticContactHref = surface.contactLinks[0] || '';
    const initialUrl = staticContactHref || reachableBase.toString();
    console.log('[acquisition-browser] surface', lead.id, surface.kind, staticContactHref || 'homepage');
    try {
      await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: staticContactHref ? 3_000 : 4_500, signal });
    } catch (e: any) {
      const message = clean(e?.message || e, 500);
      if (!/Navigation timeout/i.test(message)) throw e;
    }
    await page.waitForFunction(() => document.readyState !== 'loading', { timeout: 800, signal }).catch(() => null);
    const html = await page.content();
    const lang = detectLanguage(html, new URL(initialUrl));
    const target = message(lang, clean(lead.nome_empresa, 180));

    const links = await page.evaluate(() => Array.from(document.querySelectorAll('a')).map(a => ({
      text: (a.textContent || '').trim(),
      href: (a as HTMLAnchorElement).href
    })).filter(x => x.href));

    const sameOrigin = (href: string) => {
      try { return new URL(href).origin === reachableBase.origin; } catch { return false; }
    };

    const publicChannels = normalizePublicChannels(links
      .map(x => x.href)
      .filter(h => /^(mailto:|tel:)/i.test(h) || /(?:wa\.me|api\.whatsapp\.com|whatsapp\.com\/send)/i.test(h)));
    const visiblePhone = normalizePublicPhones((await page.evaluate(() => document.body?.innerText || ''))
      .match(/(?:\+\d[\d .()-]{7,}\d|\(\d{2}\)[ .-]?\d{4,5}[ .-]?\d{4}|\b\d{2}[ .-]?\d{4,5}[ .-]?\d{4}\b)/g) || []);

    // Preserve discovered public channels, but do not stop here: if the official
    // site also exposes a safe contact form, use that form. The user's goal is
    // contact, not merely discovery. Public channels remain available for manual
    // follow-up when no safe form exists.
    const homepageChannelPayload = (publicChannels.length || visiblePhone.length)
      ? channelPayload(publicChannels, visiblePhone)
      : null;

    const contactPattern = /(contact|contato|contacto|fale|fale-conosco|habla|kontakt|contatti|comercial|sales|business|partnership|support|atendimento|suporte)/i;
    const contactLinks = staticContactHref
      ? [{ text: 'static-contact', href: staticContactHref }]
      : links
        .filter(x => contactPattern.test(`${x.text} ${x.href}`))
        .filter(x => sameOrigin(x.href) && !/javascript:|#/.test(x.href))
        .slice(0, 2);


    // If the homepage already exposes a public first-party channel and there is
    // no explicit contact-page link, preserve it immediately. Do not waste the
    // browser budget guessing URLs such as /contact on sites that do not expose
    // them. The channel is an actionable contact path for manual follow-up.
    if (!contactLinks.length && homepageChannelPayload) {
      throw new Error(JSON.stringify(homepageChannelPayload));
    }

    const guessedPaths = lang === 'pt' ? ['/contato','/fale-conosco'] : lang === 'es' ? ['/contacto','/contact'] : lang === 'fr' ? ['/contact','/contacts'] : ['/contact','/contact-us'];
    for (const path of guessedPaths) {
      try {
        const href = new URL(path, base).toString();
        if (!contactLinks.some(x => x.href === href)) contactLinks.push({ text: path, href });
      } catch {}
    }

    if (!contactLinks.length) {
      throw new Error('formulario_contato_nao_encontrado');
    }
    let lastError = 'formulario_contato_nao_encontrado';

    for (const contact of contactLinks) {
      try {
        await page.goto(contact.href, { waitUntil: 'domcontentloaded', timeout: 3_000, signal });
      } catch (e: any) {
        const navMessage = clean(e?.message || e, 500);
        if (!/Navigation timeout/i.test(navMessage)) {
          lastError = navMessage;
          continue;
        }
      }
      await page.waitForFunction(() => document.readyState !== 'loading', { timeout: 800, signal }).catch(() => null);

      const pageChannels = normalizePublicChannels(await page.evaluate(() => Array.from(document.querySelectorAll('a')).map((a: any) => a.href || '')
        .filter((h: string) => /^(mailto:|tel:)/i.test(h) || /(?:wa[.]me|api[.]whatsapp[.]com|whatsapp[.]com\/send)/i.test(h)).slice(0, 10)));
      const pageText = await page.evaluate(() => document.body?.innerText || '');
      if (/(?:do not contact|do not solicit|no unsolicited|não entre em contato|nao entre em contato|não enviar|nao enviar|sem contato comercial|no commercial solicitation)/i.test(pageText)) {
        lastError = 'site_no_outreach_notice'; continue;
      }
      const pagePhones = normalizePublicPhones(pageText.match(/(?:\+\d[\d .()-]{7,}\d|\(\d{2}\)[ .-]?\d{4,5}[ .-]?\d{4}|\b\d{2}[ .-]?\d{4,5}[ .-]?\d{4}\b)/g) || []);
      if (pageChannels.length || pagePhones.length) {
        // Keep looking for a form on this page. A discovered channel is useful,
        // but a safe first-party form is the actionable automated contact path.
      }

      const formInfo: any = await page.evaluate(() => {
        const forms = Array.from(document.querySelectorAll('form'));
        return forms.map((form: any) => ({
          action: form.action || location.href,
          method: (form.method || 'post').toLowerCase(),
          fields: Array.from(form.querySelectorAll('input,textarea,select')).map((el: any) => ({
            tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '',
            placeholder: el.placeholder || '', aria: el.getAttribute('aria-label') || '', required: !!el.required,
            value: el.value || '', contenteditable: el.getAttribute('contenteditable') || '',
            options: el.tagName.toLowerCase()==='select' ? Array.from(el.options).slice(0,8).map((o:any)=>o.text) : []
          })),
          text: (form.innerText || '').slice(0,5000)
        }));
      });

      if (!formInfo.length) {
        const text = await page.evaluate(() => (document.body?.innerText || '').slice(0,12000));
        const emails = Array.from(new Set((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+[.][A-Z]{2,}/gi) || [])
          .map(x => x.toLowerCase())
          .filter(x => !/example[.]|noreply@|no-reply@/i.test(x)))).slice(0, 5);
        const discoveredChannels = normalizePublicChannels([
          ...(homepageChannelPayload?.channels || []),
          ...pageChannels,
          ...pagePhones,
          ...emails.map(email => `mailto:${email}`)
        ]);
        if (discoveredChannels.length) {
          const payload = channelPayload(
            discoveredChannels.filter(x => !/^\+?\d[\d .()-]{7,}\d$/.test(x)),
            discoveredChannels.filter(x => /^\+?\d[\d .()-]{7,}\d$/.test(x))
          );
          throw new Error(JSON.stringify(payload));
        }
        lastError = 'nenhum_formulario'; continue;
      }

      const usableForms = formInfo.filter((f: any) => {
        if (/captcha|recaptcha|hcaptcha|turnstile/i.test(JSON.stringify(f))) return false;
        try {
          const action = new URL(f.action || contact.href, page.url());
          return action.origin === base.origin;
        } catch {
          return false;
        }
      });
      if (!usableForms.length) { lastError = 'captcha_requer_intervencao'; continue; }

      const form = usableForms.find((f: any) => f.fields.some((x:any)=>/textarea/i.test(x.tag)))
        || usableForms.find((f: any) => f.fields.some((x:any)=>/message|mensagem|mensaje|nachricht|comments?|inquiry|enquiry/i.test([x.name,x.id,x.placeholder,x.aria].join(' '))))
        || usableForms[0];

      const fields = form.fields;
      const pick = (rx: RegExp) => fields.find((f:any) => rx.test([f.name,f.id,f.placeholder,f.aria].join(' ')));
      const name = pick(/(^|\b)(name|nome|nombre|nom|full.?name|contact.?name)(\b|$)/i);
      const email = pick(/email|e-mail|correo|courriel/i);
      const company = pick(/company|empresa|sociedad|entreprise|firma/i);
      const subject = pick(/subject|assunto|asunto|objet|betreff/i);
      let msg = pick(/message|mensagem|mensaje|nachricht|comments?|coment[aá]rio|inquiry|enquiry|request|consulta|solicita/i);
      if (!msg) {
        const editable = await page.$('[contenteditable="true"]');
        if (editable) msg = { id: '', name: '', placeholder: '', aria: '', contenteditable: 'true' };
      }
      if (!msg) { lastError = 'campo_mensagem_nao_encontrado'; continue; }

      const fill = async (field: any, value: string) => {
        if (!field || !value) return;
        const escapeAttr = (value: string) => value.replace(/\\\\/g, '\\\\\\').replace(/"/g, '\\\\"');
        const selector = field.contenteditable === 'true' ? '[contenteditable="true"]'
          : field.id ? `[id="${escapeAttr(field.id)}"]`
          : field.name ? `[name="${escapeAttr(field.name)}"]` : '';
        if (!selector) return;
        const el = await page.$(selector); if (!el) return;
        await el.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.keyboard.type(value);
      };

      await fill(name, 'Equipe Filtra.AI');
      await fill(email, clean(process.env.ACQUISITION_BROWSER_FROM_EMAIL || process.env.SMTP_FROM || 'contato@filtraai.com', 320));
      await fill(company, 'Filtra.AI');
      await fill(subject, target.subject);
      await fill(msg, target.body);

      const requiredCheckboxes = await page.$eval('input[type="checkbox"][required]', els => els.length);
      if (requiredCheckboxes > 0) { lastError = 'checkbox_obrigatorio_requer_intervencao'; continue; }

      const formSelector = form.fields.some((f:any) => /textarea/i.test(f.tag)) ? 'form:has(textarea)' : 'form';
      const submit = await page.$(`${formSelector} button[type="submit"],${formSelector} input[type="submit"],${formSelector} button`);
      if (!submit) { lastError = 'botao_envio_nao_encontrado'; continue; }

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 3_000, signal }).catch(() => null),
        submit.click(),
      ]);
      await page.waitForTimeout(500);

      const finalUrl = await page.url();
      const confirmation = await page.evaluate(() => document.body.innerText.slice(0,5000));
      const looksSuccessful = /(thank you|thanks|obrigad|gracias|merci|danke|grazie|sent successfully|mensagem enviada|enviado com sucesso|message sent)/i.test(confirmation);
      if (looksSuccessful) {
        return {
          ok: true,
          status: 'sent',
          lang,
          form_url: contact.href,
          final_url: finalUrl,
          discovered_channels: [
            ...(homepageChannelPayload?.channels || []),
            ...pageChannels,
            ...pagePhones,
          ].slice(0, 10),
        };
      }
      // A redirect alone is not proof that the form was accepted. Preserve the
      // attempt as unconfirmed instead of claiming a successful contact.
      return {
        ok: false,
        status: 'submitted_unconfirmed',
        lang,
        form_url: contact.href,
        final_url: finalUrl,
        discovered_channels: [
          ...(homepageChannelPayload?.channels || []),
          ...pageChannels,
          ...pagePhones,
        ].slice(0, 10),
      };
    }

    if (homepageChannelPayload) {
      throw new Error(JSON.stringify(homepageChannelPayload));
    }
    throw new Error(lastError);
  } finally {
    if (browser) {
      await Promise.race([
        browser.close().catch(() => undefined),
        new Promise<void>(resolve => setTimeout(resolve, 1_500)),
      ]);
    }
  }
}

async function queueMetrics(db: any) {
  const status = await db.all(`SELECT browser_status, COUNT(*)::int AS count FROM leads WHERE acquisition_eligible=1 AND COALESCE(acquisition_suppressed,0)=0 GROUP BY browser_status ORDER BY browser_status`);
  const failures = await db.all(`SELECT
      CASE
        WHEN browser_last_result ILIKE '%site_private_or_unresolvable_host%' OR browser_last_result ILIKE '%site_preflight_unreachable%' THEN 'unreachable'
        WHEN browser_last_result ILIKE '%site_preflight_timeout%' OR browser_last_result ILIKE '%site_static_timeout%' OR browser_last_result ILIKE '%browser_timeout_20s%' THEN 'timeout'
        WHEN browser_last_result ILIKE '%site_http_404%' OR browser_last_result ILIKE '%site_http_410%' THEN 'http_404_410'
        WHEN browser_last_result ILIKE '%site_http_5%' THEN 'http_5xx'
        WHEN browser_last_result ILIKE '%captcha_requer_intervencao%' THEN 'captcha_or_protection'
        WHEN browser_last_result ILIKE '%site_no_outreach_notice%' THEN 'no_outreach_notice'
        WHEN browser_last_result ILIKE '%site_no_contact_surface%' OR browser_last_result ILIKE '%formulario_contato_nao_encontrado%' OR browser_last_result ILIKE '%nenhum_formulario%' THEN 'no_contact_surface'
        WHEN browser_last_result ILIKE '%manual_channel_available%' THEN 'manual_channel'
        WHEN browser_last_result ILIKE '%site_non_html%' THEN 'non_html'
        WHEN browser_last_result ILIKE '%site_oficial_ausente%' THEN 'missing_website'
        WHEN browser_last_result IS NULL OR BTRIM(browser_last_result) = '' THEN 'unknown'
        ELSE 'other'
      END AS reason,
      COUNT(*)::int AS count
    FROM leads
    WHERE acquisition_eligible=1 AND COALESCE(acquisition_suppressed,0)=0
      AND browser_status='failed'
    GROUP BY 1
    ORDER BY count DESC`);
  return { status, failures };
}

async function selectionDiagnostics(db: any) {
  const row = await db.get(`
    SELECT
      COUNT(*) FILTER (
        WHERE acquisition_eligible=1
          AND COALESCE(acquisition_suppressed,0)=0
      )::int AS eligible,
      COUNT(*) FILTER (
        WHERE acquisition_eligible=1
          AND COALESCE(acquisition_suppressed,0)=0
          AND (acquisition_opted_in_at IS NOT NULL OR acquisition_contact_basis = 'b2b_public_prospect')
      )::int AS contact_basis,
      COUNT(*) FILTER (
        WHERE acquisition_eligible=1
          AND COALESCE(acquisition_suppressed,0)=0
          AND (acquisition_opted_in_at IS NOT NULL OR acquisition_contact_basis = 'b2b_public_prospect')
          AND browser_status IN ('pending','contact_attempted','channel_found')
      )::int AS status_ok,
      COUNT(*) FILTER (
        WHERE acquisition_eligible=1
          AND COALESCE(acquisition_suppressed,0)=0
          AND (acquisition_opted_in_at IS NOT NULL OR acquisition_contact_basis = 'b2b_public_prospect')
          AND browser_status IN ('pending','contact_attempted','channel_found')
          AND COALESCE(browser_attempts,0) < ${MAX_ATTEMPTS}
      )::int AS attempts_ok,
      COUNT(*) FILTER (
        WHERE acquisition_eligible=1
          AND COALESCE(acquisition_suppressed,0)=0
          AND (acquisition_opted_in_at IS NOT NULL OR acquisition_contact_basis = 'b2b_public_prospect')
          AND browser_status IN ('pending','contact_attempted','channel_found')
          AND COALESCE(browser_attempts,0) < ${MAX_ATTEMPTS}
          AND (browser_next_at IS NULL OR browser_next_at <= CURRENT_TIMESTAMP)
      )::int AS retry_ok,
      COUNT(*) FILTER (
        WHERE acquisition_eligible=1
          AND COALESCE(acquisition_suppressed,0)=0
          AND (acquisition_opted_in_at IS NOT NULL OR acquisition_contact_basis = 'b2b_public_prospect')
          AND browser_status IN ('pending','contact_attempted','channel_found')
          AND COALESCE(browser_attempts,0) < ${MAX_ATTEMPTS}
          AND (browser_next_at IS NULL OR browser_next_at <= CURRENT_TIMESTAMP)
          AND (
            NULLIF(BTRIM(COALESCE(raw_json::jsonb->>'website','')), '') IS NOT NULL
            OR NULLIF(BTRIM(COALESCE(raw_json::jsonb->>'websiteUri','')), '') IS NOT NULL
            OR NULLIF(BTRIM(COALESCE(raw_json::jsonb->'profile'->>'website','')), '') IS NOT NULL
            OR NULLIF(BTRIM(COALESCE(raw_json::jsonb->'profile'->>'websiteUri','')), '') IS NOT NULL
          )
      )::int AS website_ok
    FROM leads
  `);
  const missingBasisBySource = await db.all(`SELECT COALESCE(NULLIF(BTRIM(acquisition_source),''), NULLIF(BTRIM(fonte),''), 'unknown') AS source, COUNT(*)::int AS count FROM leads WHERE acquisition_eligible=1 AND COALESCE(acquisition_suppressed,0)=0 AND acquisition_opted_in_at IS NULL AND acquisition_contact_basis IS NULL GROUP BY 1 ORDER BY count DESC LIMIT 10`);
  return {
    eligible: Number(row?.eligible || 0),
    contact_basis: Number(row?.contact_basis || 0),
    status_ok: Number(row?.status_ok || 0),
    attempts_ok: Number(row?.attempts_ok || 0),
    retry_ok: Number(row?.retry_ok || 0),
    website_ok: Number(row?.website_ok || 0),
    missing_basis_by_source: missingBasisBySource,
  };
}

async function tick() {
  if (!ENABLED || running) return;
  running = true;
  try {
    const db = getDb();
    await ensureSchema(db);
    const used = await sentToday(db);
    if (used >= DAILY_CAP) {
      console.log('[acquisition-browser] tick', { used, candidates: 0, cap: DAILY_CAP, concurrency: CONCURRENCY, reason: 'daily_cap', metrics: await queueMetrics(db) });
      return;
    }
    const selection = await selectionDiagnostics(db);
    const batchSize = Math.max(1, Math.min(DAILY_CAP - used, Math.max(CONCURRENCY * 5, 5)));
    const candidates = await getCandidates(db, batchSize);
    const queue = candidates.slice(0, DAILY_CAP - used);
    console.log('[acquisition-browser] tick', JSON.stringify({ used, selection, candidates: candidates.length, selected: queue.length, cap: DAILY_CAP, concurrency: CONCURRENCY, reason: queue.length ? 'processing' : 'no_candidates', metrics: await queueMetrics(db) }));
    for (let i = 0; i < queue.length; i += CONCURRENCY) {
      await Promise.all(queue.slice(i, i + CONCURRENCY).map((lead) => processLead(db, lead)));
    }
  } finally {
    running = false;
  }
}

async function processLead(db: any, lead: any) {
  // channel_found is a manual/public contact queue, not a browser-processing state.
  // Do not rerun Chromium against a lead whose actionable public channel was already discovered.
  if (lead.browser_status === 'channel_found') {
    console.log('[acquisition-browser] channel_found queued for manual follow-up', lead.id, lead.nome_empresa || '');
    return;
  }
  console.log('[acquisition-browser] start', lead.id, lead.nome_empresa || '');
  try {
    const controller = new AbortController();
    let result: any;
    try {
      result = await Promise.race([
        runOne(lead, controller.signal),
        new Promise((_, reject) => setTimeout(() => {
          controller.abort();
          reject(new Error('browser_timeout_25s'));
        }, 25_000)),
      ]);
    } finally {
      controller.abort();
    }
    const serialized = JSON.stringify(result).slice(0, 5000);
    if (result?.status === 'submitted_unconfirmed') {
      await db.run(`UPDATE leads SET browser_status='contact_attempted',browser_last_at=CURRENT_TIMESTAMP,browser_last_result=?,browser_channel=NULL,browser_channel_data=NULL,browser_attempts=browser_attempts+1,browser_next_at=CURRENT_TIMESTAMP + INTERVAL '24 hours',acquisition_stage='contacted' WHERE id=?`, [serialized, lead.id]);
      await db.run(`INSERT INTO acquisition_events (id,lead_id,event_type,source,occurred_at,metadata_json) VALUES (?,?,?,?,CURRENT_TIMESTAMP,?)`,
        [crypto.randomUUID(),lead.id,'browser.submitted_unconfirmed','acquisition_browser',JSON.stringify(result).slice(0,20000)]);
      console.log('[acquisition-browser] submitted_unconfirmed', lead.id, result);
    } else {
      await db.run(`UPDATE leads SET browser_status='sent',browser_last_at=CURRENT_TIMESTAMP,browser_last_result=?,browser_channel=NULL,browser_channel_data=NULL,browser_attempts=browser_attempts+1,browser_next_at=NULL,acquisition_stage='contacted' WHERE id=?`, [serialized, lead.id]);
      await db.run(`INSERT INTO acquisition_events (id,lead_id,event_type,source,occurred_at,metadata_json) VALUES (?,?,?,?,CURRENT_TIMESTAMP,?)`,
        [crypto.randomUUID(),lead.id,'browser.sent','acquisition_browser',JSON.stringify(result).slice(0,20000)]);
      console.log('[acquisition-browser] sent', lead.id, result);
    }
  } catch (e: any) {
    const rawError = String(e?.message || e || '');
    let channelPayloadParsed: any = null;
    try { channelPayloadParsed = JSON.parse(rawError); } catch {}
    const error = clean(channelPayloadParsed ? JSON.stringify(channelPayloadParsed) : rawError, 5000);
    const channelFound = channelPayloadParsed?.reason === 'manual_channel_available';
    const retryHours = /site_http_404|site_http_410|ERR_NAME_NOT_RESOLVED|site_private_or_unresolvable_host|site_no_contact_surface|site_no_outreach_notice|site_non_html|captcha_requer_intervencao/i.test(error) ? 72
      : /site_preflight_timeout|site_static_timeout|browser_timeout_20s/i.test(error) ? 12
      : 6;
    const nextStatus = channelFound ? 'channel_found' : (Number(lead.browser_attempts || 0) + 1 >= MAX_ATTEMPTS ? 'failed' : 'pending');
    await db.run(`UPDATE leads SET browser_attempts=browser_attempts+1,browser_last_at=CURRENT_TIMESTAMP,browser_last_result=?,browser_channel=?,browser_channel_data=?,browser_status=?,browser_next_at=CASE WHEN ? THEN NULL ELSE CURRENT_TIMESTAMP + INTERVAL '${retryHours} hours' END,acquisition_stage=CASE WHEN ? THEN 'manual_channel' ELSE acquisition_stage END WHERE id=?`,
      [error, channelFound ? (channelPayloadParsed?.channel || 'manual') : null, channelFound ? JSON.stringify(channelPayloadParsed || {}).slice(0,5000) : null, nextStatus, channelFound, channelFound, lead.id]);
    console.warn('[acquisition-browser]', lead.id, error);
  } finally {
    console.log('[acquisition-browser] done', lead.id, lead.nome_empresa || '');
  }
}

export async function runAcquisitionBrowserBotTick(force = false) {
  if (!ENABLED) return;
  const now = Date.now();
  if (!force && now - lastTriggeredAt < INTERVAL_MS) return;
  lastTriggeredAt = now;

  if (!CHILD_MODE) {
    const script = path.join(process.cwd(), 'scripts', 'acquisitionBrowserOnce.ts');
    const tsx = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const child = spawn(process.execPath, [tsx, script], {
      env: { ...process.env, ACQUISITION_BROWSER_BOT: '1', ACQUISITION_BROWSER_CHILD: '1' },
      stdio: 'inherit',
    });
    const watchdog = setTimeout(() => {
      console.error('[acquisition-browser] worker timeout; killing child', { pid: child.pid, timeout_ms: 180000 });
      try { child.kill('SIGKILL'); } catch {}
    }, 180000);
    console.log('[acquisition-browser] spawned isolated worker pid=' + String(child.pid || 'unknown'));
    child.on('error', (e) => {
      clearTimeout(watchdog);
      console.error('[acquisition-browser] worker spawn failed:', e?.message || e);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(watchdog);
      console.log('[acquisition-browser] worker exit', { code, signal });
    });
    return;
  }

  console.log('[acquisition-browser] worker heartbeat', new Date(now).toISOString());
  try {
    await Promise.race([
      tick(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('tick_timeout_180s')), 180_000)),
    ]);
    console.log('[acquisition-browser] worker cycle complete');
  } catch (e: any) {
    running = false;
    console.error('[acquisition-browser] worker tick failed:', e?.message || e);
  }
}

export async function startAcquisitionBrowserBot() {
  if (started) return;
  if (!ENABLED) {
    console.log('[acquisition-browser] OFF — defina ACQUISITION_BROWSER_BOT=1 para ativar');
    return;
  }
  started = true;
  const db = getDb();
  await ensureSchema(db);
  console.log(`[acquisition-browser] ON cap=${DAILY_CAP} interval=${INTERVAL_MS}ms scheduler=internal-isolated-worker`);
  void runAcquisitionBrowserBotTick(true);
  const timer = setInterval(() => {
    void runAcquisitionBrowserBotTick(true);
  }, INTERVAL_MS);
  timer.unref();
}
