/**
 * Trial 7 dias — SQLite + Postgres.
 * CNPJ/Tax ID é opcional no trial; e-mail é o identificador principal.
 */
import crypto from 'crypto';
import type { Database } from 'sqlite';
import type { Response } from 'express';
import { getDb, slugify, slugUnico } from '../lib/db.js';
import { createUsuarioForEmpresa } from '../passwordResetRoutes.js';
import { normalizarWhatsapp } from '../lib/whatsapp.js';
import { notificarTrialAtivado } from '../lib/notifications.js';
import { setAuthCookie, signAccessToken } from '../lib/auth.js';
import { canonicalTaxId, taxIdValido } from '../lib/cnpj.js';
import { notifyN8n } from '../lib/n8n.js';

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
};

export type TrialResult = { success: true; empresa_id: string; slug: string; link_acesso: string; link_painel: string; expira_em: string; token?: string; tokenPayload?: { id: string; nome_funcionario: string; empresa_id: string } };

export class TrialConflictError extends Error { status = 409; constructor(message = 'Já existe uma conta com estes dados.') { super(message); this.name = 'TrialConflictError'; } }
export class TrialValidationError extends Error { status = 400; constructor(message: string) { super(message); this.name = 'TrialValidationError'; } }
function isUniqueViolation(e: any): boolean { const code = String(e?.code || ''); const msg = String(e?.message || e || ''); return code === '23505' || code === 'SQLITE_CONSTRAINT' || /unique|duplicate|constraint/i.test(msg); }
function syntheticTaxId(): string { return `INTL${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`; }

export async function ativarTrial(input: TrialInput, db: Database = getDb(), res?: Response): Promise<TrialResult> {
  const rawTax = String(input.tax_id || input.cnpj || '').trim();
  let taxId = rawTax ? canonicalTaxId(rawTax) : syntheticTaxId();
  if (rawTax && !taxIdValido(rawTax)) throw new TrialValidationError('Identificador fiscal inválido. Use CNPJ (Brasil) ou Tax ID (5–20 caracteres), ou deixe em branco.');

  const nome = String(input.nome_empresa).trim();
  const email = String(input.email).trim().toLowerCase();
  const senha = String(input.senha);
  const googleReviewUrl = input.google_review_url ? String(input.google_review_url) : '';
  const wpp = normalizarWhatsapp(input.whatsapp || null);
  if (!nome || nome.length < 2) throw new TrialValidationError('Nome da empresa inválido.');
  if (!email.includes('@')) throw new TrialValidationError('E-mail inválido.');
  if (input.whatsapp && String(input.whatsapp).trim() && !wpp) throw new TrialValidationError('WhatsApp inválido. Use DDD + número (ex: 11999998888) ou código do país.');

  const emailUser = await db.get(`SELECT id FROM usuarios WHERE lower(email) = lower(?) LIMIT 1`, [email]);
  if (emailUser) throw new TrialConflictError('Este e-mail já está cadastrado.');
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
    if (/e-mail já está em uso|email already/i.test(String(e?.message || ''))) throw new TrialConflictError('Este e-mail já está cadastrado.');
    throw new TrialValidationError(e?.message || 'Falha ao criar usuário.');
  }

  const usuario = (await db.get(`SELECT id, nome_funcionario, empresa_id FROM usuarios WHERE email = ? LIMIT 1`, [email])) || (await db.get(`SELECT id, nome_funcionario, empresa_id FROM usuarios WHERE empresa_id = ? LIMIT 1`, [id])) || (await db.get(`SELECT id, nome_funcionario, empresa_id FROM usuarios WHERE id = ?`, [usuarioId]));
  const tokenPayload = { id: String(usuario?.id || usuarioId), nome_funcionario: String(usuario?.nome_funcionario || nome), empresa_id: id };
  let token: string;
  try { token = signAccessToken(tokenPayload); if (res) { try { setAuthCookie(res, token); } catch (ce: any) { console.warn('[trial] cookie:', ce?.message || ce); } } } catch (e: any) { console.error('[trial] JWT:', e?.message || e); throw new TrialValidationError('Falha ao gerar token. Verifique JWT_SECRET no Render.'); }

  notificarTrialAtivado({ email, nomeEmpresa: nome, slug, empresaId: id, expiraEm, locale: input.locale }).catch((e) => console.warn('e-mail trial:', e?.message || e));
  notifyN8n('trial.ativado', { empresa_id: id, slug, cnpj: taxId, tax_id: taxId, nome_empresa: nome, email, whatsapp: wpp, google_review_url: googleReviewUrl || null, locale: input.locale || 'pt-BR', expira_em: expiraEm, link_painel: `${APP_URL}/painel/${slug}`, link_avaliacao: `${APP_URL}/avaliacao/${slug}` });

  return { success: true, empresa_id: id, slug, link_acesso: `${APP_URL}/avaliacao/${slug}`, link_painel: `${APP_URL}/painel/${slug}`, expira_em: expiraEm, token, tokenPayload };
}
