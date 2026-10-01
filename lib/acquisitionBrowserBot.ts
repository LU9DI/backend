import crypto from 'crypto';
import puppeteer from 'puppeteer-core';
import { getDb } from './db.js';

const ENABLED = process.env.ACQUISITION_BROWSER_BOT === '1';
const INTERVAL_MS = Math.max(60_000, Number(process.env.ACQUISITION_BROWSER_INTERVAL_MS || 300_000));
const DAILY_CAP = Math.max(1, Math.min(30, Number(process.env.ACQUISITION_BROWSER_DAILY_CAP || 10)));
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

async function getCandidates(db: any) {
  return db.all(
    `SELECT id,nome_empresa,email,raw_json,acquisition_source,browser_attempts
       FROM leads
      WHERE acquisition_eligible=1
        AND COALESCE(acquisition_suppressed,0)=0
        AND browser_status='pending'
        AND COALESCE(browser_attempts,0) < ?
        AND (browser_next_at IS NULL OR browser_next_at <= CURRENT_TIMESTAMP)
        AND (
          NULLIF(BTRIM(COALESCE(raw_json::jsonb->>'website','')), '') IS NOT NULL
          OR NULLIF(BTRIM(COALESCE(raw_json::jsonb->>'websiteUri','')), '') IS NOT NULL
          OR NULLIF(BTRIM(COALESCE(raw_json::jsonb->'profile'->>'website','')), '') IS NOT NULL
          OR NULLIF(BTRIM(COALESCE(raw_json::jsonb->'profile'->>'websiteUri','')), '') IS NOT NULL
        )
      ORDER BY criado_em ASC
      LIMIT 10`,
    [MAX_ATTEMPTS]
  );
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

async function runOne(lead: any) {
  const db = getDb();
  const website = extractWebsite(lead.raw_json);
  const base = validUrl(website);
  if (!base) throw new Error('site_oficial_ausente');

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('FiltraAI-Acquisition/1.0 (+https://filtraai.com)');
    await page.setViewport({ width: 1365, height: 900 });
    try {
      await page.goto(base.toString(), { waitUntil: 'domcontentloaded', timeout: 8_000 });
    } catch (e: any) {
      const message = clean(e?.message || e, 500);
      if (!/Navigation timeout/i.test(message)) throw e;
    }
    await page.waitForFunction(() => document.readyState !== 'loading', { timeout: 4_000 }).catch(() => null);
    const html = await page.content();
    const lang = detectLanguage(html, base);
    const target = message(lang, clean(lead.nome_empresa, 180));

    const links = await page.evaluate(() => Array.from(document.querySelectorAll('a')).map(a => ({
      text: (a.textContent || '').trim(),
      href: (a as HTMLAnchorElement).href
    })).filter(x => x.href));

    const sameOrigin = (href: string) => {
      try { return new URL(href).origin === base.origin; } catch { return false; }
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
    const contactLinks = links
      .filter(x => contactPattern.test(`${x.text} ${x.href}`))
      .filter(x => sameOrigin(x.href) && !/javascript:|#/.test(x.href))
      .slice(0, 3);
    const guessedPaths = ['/contato','/contact','/contact-us','/fale-conosco','/atendimento','/suporte','/support','/comercial','/sales'];
    for (const path of guessedPaths) {
      try {
        const href = new URL(path, base).toString();
        if (!contactLinks.some(x => x.href === href)) contactLinks.push({ text: path, href });
      } catch {}
    }

    if (!contactLinks.length) {
      if (homepageChannelPayload) throw new Error(JSON.stringify(homepageChannelPayload));
      throw new Error('formulario_contato_nao_encontrado');
    }
    let lastError = 'formulario_contato_nao_encontrado';

    for (const contact of contactLinks) {
      try {
        await page.goto(contact.href, { waitUntil: 'domcontentloaded', timeout: 8_000 });
      } catch (e: any) {
        const navMessage = clean(e?.message || e, 500);
        if (!/Navigation timeout/i.test(navMessage)) {
          lastError = navMessage;
          continue;
        }
      }
      await page.waitForFunction(() => document.readyState !== 'loading', { timeout: 4_000 }).catch(() => null);

      const pageChannels = normalizePublicChannels(await page.evaluate(() => Array.from(document.querySelectorAll('a')).map((a: any) => a.href || '')
        .filter((h: string) => /^(mailto:|tel:)/i.test(h) || /(?:wa[.]me|api[.]whatsapp[.]com|whatsapp[.]com\/send)/i.test(h)).slice(0, 10)));
      const pageText = await page.evaluate(() => document.body?.innerText || '');
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
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8_000 }).catch(() => null),
        submit.click(),
      ]);
      await page.waitForTimeout(1200);

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
    await browser.close();
  }
}

async function tick() {
  if (!ENABLED || running) return;
  running = true;
  try {
    const db = getDb();
    await ensureSchema(db);
    const used = await sentToday(db);
    if (used >= DAILY_CAP) {
      console.log('[acquisition-browser] tick', { used, candidates: 0, cap: DAILY_CAP, reason: 'daily_cap' });
      return;
    }
    const candidates = await getCandidates(db);
    console.log('[acquisition-browser] tick', { used, candidates: candidates.length, cap: DAILY_CAP, reason: candidates.length ? 'processing' : 'no_candidates' });
    for (const lead of candidates.slice(0, DAILY_CAP - used)) {
      console.log('[acquisition-browser] start', lead.id, lead.nome_empresa || '');
      try {
        const result = await Promise.race([
          runOne(lead),
          new Promise((_, reject) => setTimeout(() => reject(new Error('browser_timeout_45s')), 45_000))
        ]);
        const serialized = JSON.stringify(result).slice(0, 5000);
        if (result?.status === 'submitted_unconfirmed') {
          await db.run(
            `UPDATE leads SET browser_status='contact_attempted',browser_last_at=CURRENT_TIMESTAMP,browser_last_result=?,browser_channel=NULL,browser_channel_data=NULL,browser_attempts=browser_attempts+1,browser_next_at=CURRENT_TIMESTAMP + INTERVAL '24 hours',acquisition_stage='contacted' WHERE id=?`,
            [serialized, lead.id]
          );
          console.log('[acquisition-browser] submitted_unconfirmed', lead.id, result);
        } else {
          await db.run(
            `UPDATE leads SET browser_status='sent',browser_last_at=CURRENT_TIMESTAMP,browser_last_result=?,browser_channel=NULL,browser_channel_data=NULL,browser_attempts=browser_attempts+1,browser_next_at=NULL,acquisition_stage='contacted' WHERE id=?`,
            [serialized, lead.id]
          );
          console.log('[acquisition-browser] sent', lead.id, result);
        }
      } catch (e: any) {
        const rawError = String(e?.message || e || '');
        let channelPayloadParsed: any = null;
        try { channelPayloadParsed = JSON.parse(rawError); } catch {}
        const error = clean(channelPayloadParsed ? JSON.stringify(channelPayloadParsed) : rawError, 5000);
        const channelFound = channelPayloadParsed?.reason === 'manual_channel_available';
        await db.run(
          `UPDATE leads SET browser_attempts=browser_attempts+1,browser_last_at=CURRENT_TIMESTAMP,browser_last_result=?,browser_channel=CASE WHEN ? THEN ? ELSE NULL END,browser_channel_data=CASE WHEN ? THEN ? ELSE NULL END,browser_status=CASE WHEN ? THEN 'channel_found' WHEN browser_attempts+1 >= ? THEN 'failed' ELSE 'pending' END,browser_next_at=CASE WHEN ? THEN NULL ELSE CURRENT_TIMESTAMP + INTERVAL '6 hours' END,acquisition_stage=CASE WHEN ? THEN 'manual_channel' ELSE acquisition_stage END WHERE id=?`,
          [error, channelFound, channelPayloadParsed?.channel || 'manual', channelFound, JSON.stringify(channelPayloadParsed || {}).slice(0,5000), channelFound, MAX_ATTEMPTS, channelFound, channelFound, lead.id]
        );
        console.warn('[acquisition-browser]', lead.id, error);
      }
    }
  } finally {
    running = false;
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
  setInterval(() => void tick().catch((e) => console.error('[acquisition-browser] tick failed:', e?.message || e)), INTERVAL_MS);
  console.log(`[acquisition-browser] ON cap=${DAILY_CAP} interval=${INTERVAL_MS}ms`);
  void tick().catch((e) => console.error('[acquisition-browser] initial tick failed:', e?.message || e));
}
