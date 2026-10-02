import crypto from 'crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import puppeteer from 'puppeteer-core';
import { getDb } from './db.js';

const ENABLED = process.env.ACQUISITION_BROWSER_BOT === '1';
const INTERVAL_MS = Math.max(60_000, Number(process.env.ACQUISITION_BROWSER_INTERVAL_MS || 300_000));
const DAILY_CAP = Math.max(1, Math.min(30, Number(process.env.ACQUISITION_BROWSER_DAILY_CAP || 10)));
const CONCURRENCY = Math.max(1, Math.min(2, Number(process.env.ACQUISITION_BROWSER_CONCURRENCY || 1)));
const MAX_ATTEMPTS = 2;
let started = false;
let running = false;

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
    if (digits.length < 8 || digits.length > 15) continue;
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) continue;
    if (/\b(?:cep|zip|postal|c[oó]digo|code|id|cnpj|cpf)\b/i.test(value)) continue;
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
      body: `Olá, equipe ${c}.\n\nA Filtra.AI ajuda empresas a transformar avaliações e feedback dos clientes em ações para melhorar reputação, experiência e crescimento.\n\nGostaríamos de oferecer uma auditoria gratuita da reputação online da ${c}, sem compromisso. O resultado mostra pontos de atenção nas avaliações e oportunidades práticas de melhoria.\n\nA auditoria está disponível em https://filtraai.com/auditoria-gratuita\n\nEquipe Filtra.AI`,
    },
    es: {
      subject: `Auditoría gratuita de reputación — ${c}`,
      body: `Hola, equipo de ${c}.\n\nFiltra.AI ayuda a las empresas a convertir las reseñas y comentarios de clientes en acciones para mejorar reputación, experiencia y crecimiento.\n\nNos gustaría ofrecer una auditoría gratuita de la reputación online de ${c}, sin compromiso. El resultado muestra puntos de atención y oportunidades prácticas de mejora.\n\nLa auditoría está disponible en https://filtraai.com/auditoria-gratuita\n\nEquipo Filtra.AI`,
    },
    fr: {
      subject: `Audit gratuit de réputation — ${c}`,
      body: `Bonjour, équipe ${c}.\n\nFiltra.AI aide les entreprises à transformer les avis clients en actions concrètes pour améliorer leur réputation, leur expérience client et leur croissance.\n\nNous proposons un audit gratuit de la réputation en ligne de ${c}, sans engagement.\n\nL’audit est disponible sur https://filtraai.com/auditoria-gratuita\n\nÉquipe Filtra.AI`,
    },
    de: {
      subject: `Kostenloser Reputations-Audit — ${c}`,
      body: `Hallo ${c}-Team,\n\nFiltra.AI hilft Unternehmen, Kundenbewertungen und Feedback in konkrete Maßnahmen für Reputation, Kundenerlebnis und Wachstum umzuwandeln.\n\nWir bieten ${c} einen kostenlosen, unverbindlichen Audit der Online-Reputation an.\n\nDer Audit ist verfügbar unter https://filtraai.com/auditoria-gratuita\n\nFiltra.AI Team`,
    },
    it: {
      subject: `Audit gratuito della reputazione — ${c}`,
      body: `Buongiorno team ${c}.\n\nFiltra.AI aiuta le aziende a trasformare recensioni e feedback dei clienti in azioni concrete per migliorare reputazione, esperienza e crescita.\n\nVorremmo offrire a ${c} un audit gratuito della reputazione online, senza impegno.\n\nAudit: https://filtraai.com/auditoria-gratuita\n\nTeam Filtra.AI`,
    },
    en: {
      subject: `Free reputation audit — ${c}`,
      body: `Hello ${c} team,\n\nFiltra.AI helps businesses turn customer reviews and feedback into practical actions to improve reputation, customer experience and growth.\n\nWe would like to offer ${c} a free, no-obligation online reputation audit. It highlights review trends, attention points and practical improvement opportunities.\n\nAudit: https://filtraai.com/auditoria-gratuita\n\nFiltra.AI Team`,
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
  ];
  for (const [name, type] of columns) {
    try { await db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${type}`); } catch {}
  }
  await db.exec('CREATE INDEX IF NOT EXISTS idx_browser_acq ON leads(browser_status,browser_next_at)');
}

async function sentToday(db: any) {
  const row = await db.get(
    `SELECT COUNT(*) AS c FROM leads
      WHERE browser_status IN ('sent','contact_attempted')
        AND browser_last_at >= date_trunc('day', CURRENT_TIMESTAMP)`
  );
  return Number(row?.c || 0);
}

/**
 * Queue priority (highest first):
 * 1. channel_found — public channel already known; still try official form once
 * 2. pending — fresh sites with official website
 * 3. contact_attempted — prior attempt without confirmation (respects backoff)
 * Within groups, demote DNS death, no-surface, timeouts so they do not burn the daily cap.
 */
async function getCandidates(db: any, batchSize = 2) {
  await db.run(`UPDATE leads SET browser_status='pending' WHERE browser_status='processing' AND browser_last_at < CURRENT_TIMESTAMP - INTERVAL '10 minutes'`);
  return db.all(`WITH candidates AS (
       SELECT id FROM leads
        WHERE acquisition_eligible=1 AND COALESCE(acquisition_suppressed,0)=0
          AND browser_status IN ('channel_found','pending','contact_attempted')
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
          CASE WHEN browser_attempts = 0 THEN 0 ELSE 1 END,
          CASE
            WHEN browser_last_result ILIKE '%ENOTFOUND%'
              OR browser_last_result ILIKE '%ERR_NAME_NOT_RESOLVED%'
              OR browser_last_result ILIKE '%site_private_or_unresolvable_host%'
              OR browser_last_result ILIKE '%site_private_host%'
              THEN 9
            WHEN browser_last_result ILIKE '%site_no_contact_surface%'
              OR browser_last_result ILIKE '%site_non_html%'
              THEN 8
            WHEN browser_last_result ILIKE '%site_redirect_limit%'
              OR browser_last_result ILIKE '%site_redirect_invalid%'
              THEN 7
            WHEN browser_last_result ILIKE '%site_http_404%'
              OR browser_last_result ILIKE '%site_http_410%'
              THEN 6
            WHEN browser_last_result ILIKE '%unreachable%'
              THEN 5
            WHEN browser_last_result ILIKE '%site_preflight_timeout%'
              OR browser_last_result ILIKE '%site_static_timeout%'
              OR browser_last_result ILIKE '%browser_timeout%'
              THEN 4
            WHEN browser_last_result ILIKE '%site_http_5%'
              THEN 3
            ELSE 0
          END,
          criado_em ASC
        LIMIT ?)
      UPDATE leads l SET browser_status='processing', browser_last_at=CURRENT_TIMESTAMP
        FROM candidates c WHERE l.id=c.id
      RETURNING l.id,l.nome_empresa,l.email,l.raw_json,l.acquisition_source,l.browser_attempts`, [MAX_ATTEMPTS, batchSize]);
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
  for (let hop = 0; hop < 3; hop += 1) {
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
  throw new Error('site_redirect_limit');
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
    const channels = normalizePublicChannels(hrefs.filter(h => /^(mailto:|tel:)/i.test(h) || /(?:wa\.me|api\.whatsapp\.com|whatsapp\.com\/send)/i.test(h)));
    const contactLinks = hrefs
      .filter(h => contactPattern.test(h))
      .map(h => { try { return new URL(h, base).toString(); } catch { return ''; } })
      .filter(Boolean)
      .filter(h => { try { return new URL(h).origin === base.origin; } catch { return false; } })
      .slice(0, 2);
    const hasContactText = contactPattern.test(html);
    if (safeForm) return { kind: 'form' as const, channels, contactLinks };
    if (channels.length && !contactLinks.length && !anyForm) return { kind: 'manual_channel' as const, channels, contactLinks };
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
