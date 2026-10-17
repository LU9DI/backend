/**
 * Middleware de validação de body — sem dependências externas.
 */
import type { Request, Response, NextFunction } from 'express';
import { normalizarCnpj, cnpjValido, taxIdValido, canonicalTaxId, isEmailLike } from '../lib/cnpj.js';
import { validarSenhaEmpresa } from '../lib/passwordPolicy.js';

export type FieldRule = {
  required?: boolean;
  type?: 'string' | 'number' | 'boolean' | 'email' | 'cnpj' | 'tax_id' | 'url' | 'password_empresa';
  min?: number;
  max?: number;
  integer?: boolean;
  message?: string;
  transform?: (v: unknown) => unknown;
  custom?: (v: unknown, body: Record<string, unknown>) => string | null;
};
export type Schema = Record<string, FieldRule>;
export type ValidatedRequest<T = Record<string, unknown>> = Request & { validated?: T };

function isEmail(v: string): boolean { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function isUrl(v: string): boolean { return /^https?:\/\//i.test(v); }

function applyRule(key: string, rule: FieldRule, raw: unknown, body: Record<string, unknown>): { value?: unknown; error?: string } {
  let value = raw;
  if (rule.transform) value = rule.transform(value);
  const empty = value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
  if (empty) {
    if (rule.required) return { error: rule.message || `${key} é obrigatório.` };
    // Regras condicionais (ex.: comentário obrigatório para nota baixa) precisam rodar justamente quando o campo está vazio.
    if (rule.custom) { const err = rule.custom(undefined, body); if (err) return { error: err }; }
    return { value: undefined };
  }
  switch (rule.type) {
    case 'string': { const s = String(value).trim(); if (rule.min != null && s.length < rule.min) return { error: rule.message || `${key} deve ter pelo menos ${rule.min} caracteres.` }; if (rule.max != null && s.length > rule.max) return { error: rule.message || `${key} deve ter no máximo ${rule.max} caracteres.` }; value = s; break; }
    case 'email': { const s = String(value).trim().toLowerCase(); if (!isEmail(s)) return { error: rule.message || 'E-mail inválido.' }; value = s; break; }
    case 'cnpj': { const s = normalizarCnpj(String(value)); if (!cnpjValido(s)) return { error: rule.message || 'CNPJ inválido.' }; value = s; break; }
    case 'tax_id': { if (!taxIdValido(String(value))) return { error: rule.message || 'Identificador fiscal inválido. Use CNPJ (Brasil) ou Tax ID (5–20 caracteres).' }; value = canonicalTaxId(String(value)); break; }
    case 'url': { const s = String(value).trim(); if (s && !isUrl(s)) return { error: rule.message || 'URL inválida (use http/https).' }; if (rule.max != null && s.length > rule.max) return { error: rule.message || `${key} muito longa.` }; value = s || undefined; break; }
    case 'password_empresa': { const s = String(value); const pol = validarSenhaEmpresa(s); if (!pol.ok) return { error: pol.error }; value = s; break; }
    case 'number': { const n = Number(value); if (!Number.isFinite(n)) return { error: rule.message || `${key} deve ser um número.` }; if (rule.integer && !Number.isInteger(n)) return { error: rule.message || `${key} deve ser inteiro.` }; if (rule.min != null && n < rule.min) return { error: rule.message || `${key} deve ser ≥ ${rule.min}.` }; if (rule.max != null && n > rule.max) return { error: rule.message || `${key} deve ser ≤ ${rule.max}.` }; value = n; break; }
    case 'boolean': { if (typeof value === 'boolean') break; if (value === 'true' || value === 1 || value === '1') { value = true; break; } if (value === 'false' || value === 0 || value === '0') { value = false; break; } return { error: rule.message || `${key} deve ser boolean.` }; }
    default: break;
  }
  if (rule.custom) { const err = rule.custom(value, body); if (err) return { error: err }; }
  return { value };
}

export function validateBody(schema: Schema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const fields: Record<string, string> = {}; const out: Record<string, unknown> = {};
    for (const [key, rule] of Object.entries(schema)) { const result = applyRule(key, rule, body[key], body); if (result.error) fields[key] = result.error; else if (result.value !== undefined) out[key] = result.value; }
    if (Object.keys(fields).length > 0) return res.status(400).json({ error: Object.values(fields)[0], fields });
    (req as ValidatedRequest).validated = out; req.body = { ...body, ...out }; next();
  };
}

/** Trial de 7 dias: CNPJ/Tax ID é opcional. E-mail, nome e senha são obrigatórios. */
export const schemaTrialAtivar: Schema = {
  cnpj: { required: false, type: 'tax_id' },
  tax_id: { required: false, type: 'tax_id' },
  nome_empresa: { required: true, type: 'string', min: 2, max: 120, message: 'Nome da empresa inválido.' },
  email: { required: true, type: 'email' },
  senha: { required: true, type: 'password_empresa' },
  google_review_url: { required: false, type: 'url', max: 500 },
  whatsapp: { required: false, type: 'string', max: 20 },
  locale: { required: false, type: 'string', max: 8 },
};

export const schemaLoginEmpresa: Schema = {
  cnpj: { required: false, type: 'string', max: 120, transform: (v) => String(v ?? '').trim() },
  email: { required: false, type: 'string', max: 200, transform: (v) => String(v ?? '').trim().toLowerCase() },
  login: { required: false, type: 'string', max: 200, transform: (v) => String(v ?? '').trim() },
  senha: { required: true, type: 'string', min: 1, message: 'Senha é obrigatória.' },
};
export function ensureLoginIdentifier(req: Request, res: Response, next: NextFunction) { const body = req.body || {}; const id = String(body.login || body.email || body.cnpj || '').trim(); if (!id) return res.status(400).json({ error: 'Informe CNPJ/Tax ID ou e-mail e a senha.', fields: { login: 'Obrigatório' } }); if (!isEmailLike(id) && id.replace(/[^A-Za-z0-9]/g, '').length < 5) return res.status(400).json({ error: 'Identificador inválido. Use e-mail ou Tax ID (mín. 5 caracteres).' }); next(); }

export const schemaReview: Schema = {
  name: { required: false, type: 'string', max: 100 }, rating: { required: true, type: 'number', integer: true, min: 1, max: 5, message: 'Rating deve ser inteiro entre 1 e 5.' },
  comment: { required: false, type: 'string', max: 500, custom: (v, body) => Number(body.rating) <= 3 && !String(v ?? '').trim() ? 'Comentário obrigatório para notas ≤ 3.' : null },
  client_whatsapp: { required: false, type: 'string', max: 20, custom: (v, body) => { if (Number(body.rating) > 3) return null; return String(v ?? body.whatsapp ?? '').replace(/\D/g, '').length < 8 ? 'WhatsApp/telefone do cliente é obrigatório para notas ≤ 3.' : null; } },
  whatsapp: { required: false, type: 'string', max: 20 }, empresa_id: { required: false, type: 'string', max: 100 }, empresa_ref: { required: false, type: 'string', max: 100 }, website: { required: false, type: 'string', max: 200 }, is_test: { required: false, type: 'boolean' },
  locale: { required: false, type: 'string', max: 8, transform: (v) => String(v ?? '').toLowerCase().slice(0, 2), custom: (v) => !v || ['pt', 'en', 'es', 'zh'].includes(String(v)) ? null : 'locale inválido (pt|en|es|zh).' },
};

export const schemaCheckout: Schema = { plano: { required: true, type: 'string', transform: (v) => String(v ?? '').toLowerCase().trim(), custom: (v) => ['inicial','inicial-anual','pro','pro-anual','ultra','ultra-anual','corporativo','corporativo-anual','rei','rei-anual'].includes(String(v)) ? null : 'Plano inválido.' }, empresa_id: { required: false, type: 'string', max: 100 }, email: { required: false, type: 'email' } };
