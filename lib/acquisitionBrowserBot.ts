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
    return clean(obj?.website || obj?.profile?.website || obj?.profile?.contact?.website, 2000);
  } catch { return ''; }
}

async function ensureSchema(db: any) {
  const columns = [
    ['browser_status', `TEXT NOT NULL DEFAULT 'pending'`],
    ['browser_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['browser_next_at', 'TIMESTAMPTZ'],
    ['browser_last_at', 'TIMESTAMPTZ'],
    ['browser_last_result', 'TEXT'],
  ];
  for (const [name, type] of columns) {
    try { await db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${type}`); } catch {}
  }
  await db.exec('CREATE INDEX IF NOT EXISTS idx_browser_acq ON leads(browser_status,browser_next_at)');
}

async function sentToday(db: any) {
  const row = await db.get(
    `SELECT COUNT(*) AS c FROM leads WHERE browser_status='sent' AND browser_last_at >= date_trunc('day', CURRENT_TIMESTAMP)`
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
        AND acquisition_source ILIKE '%official website%'
      ORDER BY criado_em ASC
      LIMIT 10`,
    [MAX_ATTEMPTS]
  );
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
      await page.goto(base.toString(), { waitUntil: 'domcontentloaded', timeout: 12_000 });
    } catch (e: any) {
      const message = clean(e?.message || e, 500);
      if (!/Navigation timeout/i.test(message)) throw e;
    }
    await page.waitForFunction(() => document.readyState !== 'loading', { timeout: 8_000 }).catch(() => null);
    const html = await page.content();
    const lang = detectLanguage(html, base);
    const target = message(lang, clean(lead.nome_empresa, 180));

    const links = await page.evaluate(() => Array.from(document.querySelectorAll('a')).map(a => ({
      text: (a.textContent || '').trim(),
      href: (a as HTMLAnchorElement).href
    })).filter(x => x.href));
    const contact = links.find(x => /(contact|contato|contacto|fale|habla|kontakt|contatti|comercial|sales|business|partnership)/i.test(x.text));
    if (!contact) throw new Error('formulario_contato_nao_encontrado');

    try {
      await page.goto(contact.href, { waitUntil: 'domcontentloaded', timeout: 12_000 });
    } catch (e: any) {
      // Some sites keep loading analytics/third-party resources indefinitely. If the document is usable, continue.
      const message = clean(e?.message || e, 500);
      if (!/Navigation timeout/i.test(message)) throw e;
    }
    await page.waitForFunction(() => document.readyState !== 'loading', { timeout: 8_000 }).catch(() => null);
    const formInfo: any = await page.evaluate(() => {
      const forms = Array.from(document.querySelectorAll('form'));
      return forms.map((form: any) => ({
        action: form.action || location.href,
        method: (form.method || 'post').toLowerCase(),
        fields: Array.from(form.querySelectorAll('input,textarea,select')).map((el: any) => ({
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          name: el.name || '',
          id: el.id || '',
          placeholder: el.placeholder || '',
          aria: el.getAttribute('aria-label') || '',
          required: !!el.required,
          value: el.value || '',
          contenteditable: el.getAttribute('contenteditable') || '',
          options: el.tagName.toLowerCase()==='select' ? Array.from(el.options).slice(0,8).map((o:any)=>o.text) : []
        })),
        text: (form.innerText || '').slice(0,5000)
      }));
    });

    if (!formInfo.length) throw new Error('nenhum_formulario');
    const form = formInfo.find((f: any) => f.fields.some((x:any)=>/textarea/i.test(x.tag))) || formInfo[0];
    const hasCaptcha = /captcha|recaptcha|hcaptcha|turnstile/i.test(JSON.stringify(form));
    if (hasCaptcha) throw new Error('captcha_requer_intervencao');

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
    if (!msg) throw new Error('campo_mensagem_nao_encontrado');

    const fill = async (field: any, value: string) => {
      if (!field || !value) return;
      const escapeAttr = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\\"');
      const selector = field.contenteditable === 'true'
        ? '[contenteditable="true"]'
        : field.id
          ? `[id="${escapeAttr(field.id)}"]`
          : field.name
            ? `[name="${escapeAttr(field.name)}"]`
            : '';
      if (!selector) return;
      const el = await page.$(selector);
      if (!el) return;
      await el.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.keyboard.type(value);
    };
    await fill(name, 'Equipe Filtra.AI');
    await fill(email, clean(process.env.ACQUISITION_BROWSER_FROM_EMAIL || process.env.SMTP_FROM || 'contato@filtraai.com', 320));
    await fill(company, 'Filtra.AI');
    await fill(subject, target.subject);
    await fill(msg, target.body);

    // Never accept legal/marketing consent on behalf of the recipient.
    const requiredCheckboxes = await page.$eval('input[type="checkbox"][required]', els => els.length);
    if (requiredCheckboxes > 0) throw new Error('checkbox_obrigatorio_requer_intervencao');

    const formSelector = form.fields.some((f:any) => /textarea/i.test(f.tag))
      ? 'form:has(textarea)'
      : 'form';
    const submit = await page.$(`${formSelector} button[type="submit"],${formSelector} input[type="submit"],${formSelector} button`);
    if (!submit) throw new Error('botao_envio_nao_encontrado');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12_000 }).catch(() => null),
      submit.click(),
    ]);
    await page.waitForTimeout(1200);

    const finalUrl = await page.url();
    const confirmation = await page.evaluate(() => document.body.innerText.slice(0,5000));
    const looksSuccessful = /(thank you|thanks|obrigad|gracias|merci|danke|grazie|sent successfully|mensagem enviada|enviado com sucesso|message sent)/i.test(confirmation);
    if (!looksSuccessful && finalUrl === contact.href) throw new Error('resultado_de_envio_nao_confirmado');

    return { ok: true, lang, form_url: contact.href, final_url: finalUrl };
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
    if (used >= DAILY_CAP) return;
    const candidates = await getCandidates(db);
    for (const lead of candidates.slice(0, DAILY_CAP - used)) {
      try {
        const result = await runOne(lead);
        await db.run(
          `UPDATE leads SET browser_status='sent',browser_last_at=CURRENT_TIMESTAMP,browser_last_result=?,browser_attempts=browser_attempts+1 WHERE id=?`,
          [JSON.stringify(result).slice(0,5000), lead.id]
        );
        console.log('[acquisition-browser] sent', lead.id, result);
      } catch (e: any) {
        const error = clean(e?.message || e, 500);
        await db.run(
          `UPDATE leads SET browser_attempts=browser_attempts+1,browser_last_at=CURRENT_TIMESTAMP,browser_last_result=?,browser_status=CASE WHEN browser_attempts+1 >= ? THEN 'failed' ELSE 'pending' END,browser_next_at=CURRENT_TIMESTAMP + INTERVAL '6 hours' WHERE id=?`,
          [error, MAX_ATTEMPTS, lead.id]
        );
        console.warn('[acquisition-browser]', lead.id, error);
      }
    }
  } finally {
    running = false;
  }
}

export async function startAcquisitionBrowserBot() {
  if (started || !ENABLED) return;
  started = true;
  const db = getDb();
  await ensureSchema(db);
  await tick();
  setInterval(() => void tick(), INTERVAL_MS);
  console.log(`[acquisition-browser] ON cap=${DAILY_CAP} interval=${INTERVAL_MS}ms`);
}
