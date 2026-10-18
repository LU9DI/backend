/**
 * Trial 7 dias — SQLite + Postgres.
 * CNPJ/Tax ID é opcional no trial; e-mail é o identificador principal.
 */
import crypto from 'crypto';
import dns from 'node:dns/promises';
import type { Database } from 'sqlite';
import type { Response } from 'express';
import { getDb, slugify, slugUnico } from '../lib/db.js';
import { createUsuarioForEmpresa } from '../passwordResetRoutes.js';
import { provisionEmpresaOwner } from '../lib/empresaOwnership.js';
import { normalizarWhatsapp } from '../lib/whatsapp.js';
import { notificarTrialAtivado } from '../lib/notifications.js';
import { setAuthCookie, signAccessToken } from '../lib/auth.js';
import { canonicalTaxId, taxIdValido } from '../lib/cnpj.js';
import { notifyN8n, queueN8nEvent } from '../lib/n8n.js';
import { qualifyLead } from './leadAutomation.js';
import { hashIp } from '../lib/reviewFraud.js';

const APP_URL = (process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');

export type TrialInput = {
  cnpj?: string;
  tax_id?: string;
  nome_empresa: string;
  email: string;
  senha: string;
  google_review_url?: string;
  whatsapp?: string;
  locale?: string;
  ip?: string;
};

export type TrialResult = { success: true; empresa_id: string; slug: string; link_acesso: string; link_painel: string; expira_em: string; token?: string; tokenPayload?: { id: string; nome_funcionario: string; empresa_id: string } };

export class TrialConflictError extends Error { status = 409; constructor(message = 'Já existe uma conta com estes dados.') { super(message); this.name = 'TrialConflictError'; } }
export class TrialValidationError extends Error { status = 400; constructor(message: string) { super(message); this.name = 'TrialValidationError'; } }
function isUniqueViolation(e: any): boolean { const code = String(e?.code || ''); const msg = String(e?.message || e || ''); return code === '23505' || code === 'SQLITE_CONSTRAINT' || /unique|duplicate|constraint/i.test(msg); }
function syntheticTaxId(): string { return `INTL${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`; }

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  '10minutemail.com','temp-mail.org','tempmail.com','guerrillamail.com','mailinator.com',
  'yopmail.com','sharklasers.com','guerrillamail.net','guerrillamail.org','getnada.com'
]);

function isEmailFormat(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

type EmailDnsResolver = {
  resolveMx: (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;
  resolve4: (domain: string) => Promise<string[]>;
};

const defaultEmailDnsResolver: EmailDnsResolver = {
  resolveMx: (domain) => dns.resolveMx(domain),
  resolve4: (domain) => dns.resolve4(domain),
};

let emailDnsResolver: EmailDnsResolver = defaultEmailDnsResolver;

/**
 * Fronteira de teste: substitui apenas o resolvedor usado por assertEmailUsable,
 * sem alterar o DNS global do processo. Em produção o resolvedor padrão (DNS do
 * sistema) permanece ativo; passe `null` para restaurá-lo.
 */
export function setEmailDnsResolverForTests(resolver: EmailDnsResolver | null): void {
  emailDnsResolver = resolver ?? defaultEmailDnsResolver;
}

async function assertEmailUsable(email: string): Promise<void> {
  if (!isEmailFormat(email)) throw new TrialValidationError('E-mail inválido.');
  const domain = email.split('@')[1].toLowerCase();
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
    throw new TrialValidationError('Use um e-mail permanente para ativar o teste de 7 dias.');
  }
  try {
    const mx = await emailDnsResolver.resolveMx(domain);
    if (!mx?.length) throw new Error('no mx');
  } catch {
    try {
      const addresses = await emailDnsResolver.resolve4(domain);
      if (!addresses?.length) throw new Error('no dns');
    } catch {
      throw new TrialValidationError('Não foi possível validar o domínio deste e-mail.');
    }
  }
}

export async function ativarTrial(input: TrialInput, db: Database = getDb(), res?: Response): Promise<TrialResult> {
  const rawTax = String(input.tax_id || input.cnpj || '').trim();
  let taxId = rawTax ? canonicalTaxId(rawTax) : syntheticTaxId();
  if (rawTax && !taxIdValido(rawTax)) throw new TrialValidationError('Identificador fiscal inválido. Use CNPJ (Brasil) ou Tax ID (5–20 caracteres), ou deixe em branco.');

  const nome = String(input.nome_empresa).trim();
  const email = String(input.email).trim().toLowerCase();
  const senha = String(input.senha);
  const ip = String(input.ip || '0.0.0.0');
  const ipHash = hashIp(ip);
  const googleReviewUrl = input.google_review_url ? String(input.google_review_url) : '';
  const wpp = normalizarWhatsapp(input.whatsapp || null);
  if (!nome || nome.length < 2) throw new TrialValidationError('Nome da empresa inválido.');
  await assertEmailUsable(email);
  if (input.whatsapp && String(input.whatsapp).trim() && !wpp) throw new TrialValidationError('WhatsApp inválido. Use DDD + número (ex: 11999998888) ou código do país.');

  const emailUser = await db.get(`SELECT id FROM usuarios WHERE lower(email) = lower(?) LIMIT 1`, [email]);
  if (emailUser) throw new TrialConflictError('Este e-mail já está cadastrado.');
  try {
    await db.run(`INSERT INTO trial_registrations (id, email, ip_hash) VALUES (?, ?, ?)`, [crypto.randomUUID(), email, ipHash]);
  } catch (e: any) {
    if (isUniqueViolation(e)) throw new TrialConflictError('Este e-mail ou este IP já utilizou o período de teste.');
    throw e;
  }
  if (rawTax) {
    const existente = await db.get(`SELECT id FROM empresas WHERE cnpj = ?`, [taxId]);
    if (existente) throw new TrialConflictError('Esta identificação fiscal já ativou o período de testes.');
  }

  const id = crypto.randomUUID();
  const slug = await slugUnico(slugify(nome) || 'empresa');
  const criadoEm = new Date().toISOString();
  const expiraEm = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    await db.run(`INSERT INTO empresas (id, cnpj, nome_empresa, slug, google_review_url, whatsapp_suporte, status, plan, criado_em, expira_em) VALUES (?, ?, ?, ?, ?, ?, 'trial', 'trial', ?, ?)`, [id, taxId, nome, slug, googleReviewUrl || null, wpp, criadoEm, expiraEm]);
  } catch (e: any) {
    console.error('[trial] insert empresa:', e?.code, e?.message || e);
    try { await db.run('DELETE FROM trial_registrations WHERE email = ?', [email]); } catch { /* */ }
    if (isUniqueViolation(e)) throw new TrialConflictError();
    try {
      await db.run(`INSERT INTO empresas (id, cnpj, nome_empresa, status, plan, criado_em, expira_em) VALUES (?, ?, ?, 'trial', 'trial', ?, ?)`, [id, taxId, nome, criadoEm, expiraEm]);
      try { await db.run(`UPDATE empresas SET slug = ? WHERE id = ?`, [slug, id]); } catch { /* */ }
    } catch (e2: any) {
      if (isUniqueViolation(e2)) throw new TrialConflictError();
      throw new TrialValidationError(`Falha ao criar empresa: ${String(e2?.message || e?.message || e2).slice(0, 200)}`);
    }
  }

  let usuarioId: string;
  try {
    const u = await createUsuarioForEmpresa(db, { empresaId: id, cnpj: taxId, nome, email, senha });
    usuarioId = u.id;
  } catch (e: any) {
    console.error('[trial] create usuario:', e?.message || e);
    try { await db.run('DELETE FROM empresas WHERE id = ?', [id]); } catch { /* */ }
    try { await db.run('DELETE FROM trial_registrations WHERE email = ?', [email]); } catch { /* */ }
    if (/e-mail já está em uso|email already/i.test(String(e?.message || ''))) throw new TrialConflictError('Este e-mail já está cadastrado.');
    throw new TrialValidationError(e?.message || 'Falha ao criar usuário.');
  }

  // O usuário criado junto com a empresa no próprio cadastro é o proprietário
  // legítimo: o vínculo nasce desta operação, não de um papel informado pelo
  // cliente. Sem proprietário provisionado, a administração do Dot nega por
  // padrão (fail-closed) — por isso a falha aqui desfaz a criação parcial.
  try {
    await provisionEmpresaOwner(id, usuarioId, { source: 'signup' });
  } catch (e: any) {
    console.error('[trial] owner:', e?.message || e);
    try { await db.run('DELETE FROM usuarios WHERE id = ?', [usuarioId]); } catch { /* */ }
    try { await db.run('DELETE FROM empresas WHERE id = ?', [id]); } catch { /* */ }
    try { await db.run('DELETE FROM trial_registrations WHERE email = ?', [email]); } catch { /* */ }
    throw new TrialValidationError('Não foi possível provisionar o responsável da conta. Tente novamente.');
  }

  const usuario = (await db.get(`SELECT id, nome_funcionario, empresa_id FROM usuarios WHERE email = ? LIMIT 1`, [email])) || (await db.get(`SELECT id, nome_funcionario, empresa_id FROM usuarios WHERE empresa_id = ? LIMIT 1`, [id])) || (await db.get(`SELECT id, nome_funcionario, empresa_id FROM usuarios WHERE id = ?`, [usuarioId]));
  const tokenPayload = { id: String(usuario?.id || usuarioId), nome_funcionario: String(usuario?.nome_funcionario || nome), empresa_id: id };
  let token: string;
  try { token = signAccessToken(tokenPayload); if (res) { try { setAuthCookie(res, token); } catch (ce: any) { console.warn('[trial] cookie:', ce?.message || ce); } } } catch (e: any) { console.error('[trial] JWT:', e?.message || e); throw new TrialValidationError('Falha ao gerar token. Verifique JWT_SECRET no Render.'); }

  notificarTrialAtivado({ email, nomeEmpresa: nome, slug, empresaId: id, expiraEm, locale: input.locale }).catch((e) => console.warn('e-mail trial:', e?.message || e));
  // Trial é também um lead comercial qualificado. O lead é persistido antes dos eventos
  // para que a automação continue resiliente mesmo se n8n estiver dormindo.
  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      nome_empresa TEXT,
      email TEXT,
      telefone TEXT,
      fonte TEXT,
      maps_url TEXT,
      raw_json TEXT,
      criado_em TIMESTAMPTZ NOT NULL
    )`);
    try { await db.exec('ALTER TABLE leads ADD COLUMN score INTEGER'); } catch {}
    try { await db.exec('ALTER TABLE leads ADD COLUMN qualification TEXT'); } catch {}
    try { await db.exec('ALTER TABLE leads ADD COLUMN ai_reason TEXT'); } catch {}
    const existingLead = await db.get('SELECT id, score, qualification, ai_reason FROM leads WHERE lower(email) = lower(?) AND fonte = ? LIMIT 1', [email, 'trial']);
    let leadId = String(existingLead?.id || '');
    let score = Number(existingLead?.score || 0);
    let qualification = String(existingLead?.qualification || '');
    let reason = String(existingLead?.ai_reason || '');
    if (!leadId) {
      leadId = crypto.randomUUID();
      await db.run(
        `INSERT INTO leads (id, nome_empresa, email, telefone, fonte, maps_url, raw_json, criado_em)
         VALUES (?, ?, ?, ?, 'trial', ?, ?, ?)`,
        [leadId, nome, email, wpp || null, googleReviewUrl || null,
          JSON.stringify({ empresa_id: id, slug, locale: input.locale || 'pt-BR' }).slice(0, 4000), new Date().toISOString()]
      );
      await queueN8nEvent('lead.captured', {
        lead_id: leadId, nome_empresa: nome, email, telefone: wpp || '', fonte: 'trial', empresa_id: id,
      }, { dedupeKey: 'n8n:lead.captured:' + leadId });
      const q = await qualifyLead({ nome_empresa: nome, email, telefone: wpp || '', fonte: 'trial', maps_url: googleReviewUrl });
      if (q) {
        score = q.score; qualification = q.qualification; reason = q.reason;
        await db.run('UPDATE leads SET score = ?, qualification = ?, ai_reason = ? WHERE id = ?', [score, qualification, reason, leadId]);
        await queueN8nEvent('lead.qualified', {
          lead_id: leadId, nome_empresa: nome, email, telefone: wpp || '', fonte: 'trial',
          score, qualification, reason, empresa_id: id,
        }, { dedupeKey: 'n8n:lead.qualified:' + leadId });
        if (score >= 40) {
          await queueN8nEvent('lead.followup.requested', {
            lead_id: leadId, nome_empresa: nome, email, telefone: wpp || '', fonte: 'trial',
            score, qualification, reason, action: 'create_crm_followup', empresa_id: id,
          }, { dedupeKey: 'n8n:lead.followup.requested:' + leadId });
        }
      }
    }
  } catch (e: any) {
    // Falha comercial não invalida a ativação do trial; fica registrada para observabilidade.
    console.warn('[trial] lead automation:', e?.message || e);
  }

  notifyN8n('trial.ativado', { empresa_id: id, slug, cnpj: taxId, tax_id: taxId, nome_empresa: nome, email, whatsapp: wpp, google_review_url: googleReviewUrl || null, locale: input.locale || 'pt-BR', expira_em: expiraEm, link_painel: `${APP_URL}/painel/${slug}`, link_avaliacao: `${APP_URL}/avaliacao/${slug}` });

  return { success: true, empresa_id: id, slug, link_acesso: `${APP_URL}/avaliacao/${slug}`, link_painel: `${APP_URL}/painel/${slug}`, expira_em: expiraEm, token, tokenPayload };
}
