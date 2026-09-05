/**
 * Middleware de validação de body — sem dependências externas.
 */
import type { Request, Response, NextFunction } from 'express';
import { normalizarCnpj, cnpjValido } from '../lib/cnpj.js';
import { validarSenhaEmpresa } from '../lib/passwordPolicy.js';

export type FieldRule = {
  required?: boolean;
  type?: 'string' | 'number' | 'boolean' | 'email' | 'cnpj' | 'url' | 'password_empresa';
  min?: number;
  max?: number;
  integer?: boolean;
  message?: string;
  transform?: (v: unknown) => unknown;
  custom?: (v: unknown, body: Record<string, unknown>) => string | null;
};

export type Schema = Record<string, FieldRule>;

export type ValidatedRequest<T = Record<string, unknown>> = Request & {
  validated?: T;
};

function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function isUrl(v: string): boolean {
  return /^https?:\/\//i.test(v);
}

function applyRule(
  key: string,
  rule: FieldRule,
  raw: unknown,
  body: Record<string, unknown>
): { value?: unknown; error?: string } {
  let value = raw;

  if (rule.transform) {
    value = rule.transform(value);
  }

  const empty =
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '');

  if (empty) {
    if (rule.required) {
      return { error: rule.message || `${key} é obrigatório.` };
    }
    return { value: undefined };
  }

  switch (rule.type) {
    case 'string': {
      const s = String(value).trim();
      if (rule.min != null && s.length < rule.min) {
        return { error: rule.message || `${key} deve ter pelo menos ${rule.min} caracteres.` };
      }
      if (rule.max != null && s.length > rule.max) {
        return { error: rule.message || `${key} deve ter no máximo ${rule.max} caracteres.` };
      }
      value = s;
      break;
    }
    case 'email': {
      const s = String(value).trim().toLowerCase();
      if (!isEmail(s)) return { error: rule.message || 'E-mail inválido.' };
      value = s;
      break;
    }
    case 'cnpj': {
      const s = normalizarCnpj(String(value));
      if (!cnpjValido(s)) return { error: rule.message || 'CNPJ inválido.' };
      value = s;
      break;
    }
    case 'url': {
      const s = String(value).trim();
      if (s && !isUrl(s)) return { error: rule.message || 'URL inválida (use http/https).' };
      if (rule.max != null && s.length > rule.max) {
        return { error: rule.message || `${key} muito longa.` };
      }
      value = s || undefined;
      break;
    }
    case 'password_empresa': {
      const s = String(value);
      const pol = validarSenhaEmpresa(s);
      if (!pol.ok) return { error: pol.error };
      value = s;
      break;
    }
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return { error: rule.message || `${key} deve ser um número.` };
      if (rule.integer && !Number.isInteger(n)) {
        return { error: rule.message || `${key} deve ser inteiro.` };
      }
      if (rule.min != null && n < rule.min) {
        return { error: rule.message || `${key} deve ser ≥ ${rule.min}.` };
      }
      if (rule.max != null && n > rule.max) {
        return { error: rule.message || `${key} deve ser ≤ ${rule.max}.` };
      }
      value = n;
      break;
    }
    case 'boolean': {
      if (typeof value === 'boolean') break;
      if (value === 'true' || value === 1 || value === '1') {
        value = true;
        break;
      }
      if (value === 'false' || value === 0 || value === '0') {
        value = false;
        break;
      }
      return { error: rule.message || `${key} deve ser boolean.` };
    }
    default:
      break;
  }

  if (rule.custom) {
    const err = rule.custom(value, body);
    if (err) return { error: err };
  }

  return { value };
}

export function validateBody(schema: Schema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
      string,
      unknown
    >;
    const fields: Record<string, string> = {};
    const out: Record<string, unknown> = {};

    for (const [key, rule] of Object.entries(schema)) {
      const result = applyRule(key, rule, body[key], body);
      if (result.error) {
        fields[key] = result.error;
      } else if (result.value !== undefined) {
        out[key] = result.value;
      }
    }

    if (Object.keys(fields).length > 0) {
      const first = Object.values(fields)[0];
      return res.status(400).json({
        error: first,
        fields,
      });
    }

    (req as ValidatedRequest).validated = out;
    req.body = { ...body, ...out };
    next();
  };
}

export const schemaTrialAtivar: Schema = {
  cnpj: { required: true, type: 'cnpj' },
  nome_empresa: {
    required: true,
    type: 'string',
    min: 2,
    max: 120,
    message: 'Nome da empresa inválido.',
  },
  email: { required: true, type: 'email' },
  senha: { required: true, type: 'password_empresa' },
  google_review_url: { required: false, type: 'url', max: 500 },
  whatsapp: { required: false, type: 'string', max: 20 },
};

export const schemaLoginEmpresa: Schema = {
  cnpj: {
    required: true,
    type: 'string',
    transform: (v) => normalizarCnpj(String(v ?? '')),
    custom: (v) => (String(v).length === 14 ? null : 'CNPJ inválido.'),
  },
  senha: {
    required: true,
    type: 'string',
    min: 1,
    message: 'CNPJ e senha são obrigatórios.',
  },
};

export const schemaReview: Schema = {
  name: { required: false, type: 'string', max: 100 },
  rating: {
    required: true,
    type: 'number',
    integer: true,
    min: 1,
    max: 5,
    message: 'Rating deve ser inteiro entre 1 e 5.',
  },
  comment: {
    required: false,
    type: 'string',
    max: 500,
    custom: (v, body) => {
      const rating = Number(body.rating);
      const comment = String(v ?? '').trim();
      if (rating <= 3 && !comment) {
        return 'Comentário obrigatório para notas ≤ 3.';
      }
      return null;
    },
  },
  empresa_id: { required: false, type: 'string', max: 100 },
  empresa_ref: { required: false, type: 'string', max: 100 },
  /** Honeypot — deve ficar vazio */
  website: { required: false, type: 'string', max: 200 },
  is_test: { required: false, type: 'boolean' },
};

export const schemaCheckout: Schema = {
  plano: {
    required: true,
    type: 'string',
    transform: (v) => String(v ?? '').toLowerCase().trim(),
    custom: (v) => {
      const ok = [
        'inicial',
        'inicial-anual',
        'pro',
        'pro-anual',
        'ultra',
        'ultra-anual',
        'corporativo',
        'corporativo-anual',
        'rei',
        'rei-anual',
      ].includes(String(v));
      return ok ? null : 'Plano inválido.';
    },
  },
  empresa_id: { required: false, type: 'string', max: 100 },
  email: { required: false, type: 'email' },
};
