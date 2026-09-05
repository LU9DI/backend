/**
 * Rotação de chaves JWT.
 *
 * Env:
 *   JWT_SECRET              — chave atual (obrigatória)
 *   JWT_SECRET_PREVIOUS     — chave anterior (ainda valida tokens antigos)
 *   JWT_SECRETS             — lista CSV de chaves extras (ordem: mais nova → mais antiga)
 *   JWT_KID                 — id da chave atual (default: v1)
 *   JWT_EXPIRES             — ex: 1d, 12h (default 1d)
 *
 * Como rotacionar:
 *   1. JWT_SECRET_PREVIOUS = valor antigo de JWT_SECRET
 *   2. JWT_SECRET = novo segredo forte
 *   3. JWT_KID = v2 (ou novo id)
 *   4. Reinicie a API — tokens antigos continuam válidos até expirar
 */
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

export type JwtPayload = {
  id: string;
  nome_funcionario: string;
  empresa_id: string;
  role?: string;
  kid?: string;
};

function currentKid(): string {
  return (process.env.JWT_KID || 'v1').trim();
}

function expiresIn(): string {
  return (process.env.JWT_EXPIRES || '1d').trim();
}

/** Lista de segredos para VERIFY (atual + anteriores). */
export function listVerifySecrets(): string[] {
  const out: string[] = [];
  const cur = (process.env.JWT_SECRET || '').trim();
  if (cur) out.push(cur);

  const prev = (process.env.JWT_SECRET_PREVIOUS || '').trim();
  if (prev && !out.includes(prev)) out.push(prev);

  const multi = (process.env.JWT_SECRETS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of multi) {
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

export function requireJwtSecret(): string {
  const secrets = listVerifySecrets();
  if (!secrets.length) {
    console.error('❌ JWT_SECRET não definido. Defina no backend/.env');
    process.exit(1);
  }
  return secrets[0];
}

export function signAccessToken(payload: Omit<JwtPayload, 'kid'>): string {
  const secret = requireJwtSecret();
  const kid = currentKid();
  return jwt.sign({ ...payload, kid }, secret, {
    expiresIn: expiresIn() as jwt.SignOptions['expiresIn'],
    header: { alg: 'HS256', typ: 'JWT', kid },
  });
}

export function verifyAccessToken(token: string): JwtPayload {
  const secrets = listVerifySecrets();
  let lastErr: unknown;
  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret) as JwtPayload;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Token inválido');
}

/** Gera um segredo forte (para docs / scripts). */
export function generateJwtSecret(): string {
  return crypto.randomBytes(48).toString('base64url');
}

export function jwtRotationStatus() {
  const secrets = listVerifySecrets();
  return {
    kid: currentKid(),
    expires: expiresIn(),
    keys_for_verify: secrets.length,
    has_previous: secrets.length > 1,
  };
}
