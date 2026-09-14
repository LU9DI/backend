/**
 * JWT + cookies de sessão (rotação de chave).
 * Auth de empresa/admin = JWT local (JWT_SECRET), NÃO Supabase Auth.
 */
import type { Request, Response, NextFunction } from 'express';
import {
  requireJwtSecret as _require,
  signAccessToken,
  verifyAccessToken,
  type JwtPayload,
} from './jwtKeys.js';

export const COOKIE_NAME = 'saas_auth_token';
const isProd = process.env.NODE_ENV === 'production';

export { signAccessToken, verifyAccessToken };
export type { JwtPayload };

function cookieBaseOptions() {
  const domain = process.env.COOKIE_DOMAIN?.trim() || undefined;
  return {
    httpOnly: true,
    secure: isProd || process.env.COOKIE_SECURE === 'true',
    sameSite: (isProd || process.env.COOKIE_SAMESITE === 'none' ? 'none' : 'lax') as
      | 'none'
      | 'lax'
      | 'strict',
    path: '/',
    ...(domain ? { domain } : {}),
  };
}

export function requireJwtSecret(): string {
  return _require();
}

export function setAuthCookie(res: Response, token: string) {
  const opts = {
    ...cookieBaseOptions(),
    maxAge: 24 * 60 * 60 * 1000,
  };
  res.cookie(COOKIE_NAME, token, opts);
  res.cookie('auth_token', token, opts);
}

export function clearAuthCookie(res: Response) {
  const base = cookieBaseOptions();
  res.clearCookie(COOKIE_NAME, base);
  res.clearCookie('auth_token', base);
}

export function extrairToken(req: Request): string | null {
  const fromCookie = req.cookies?.[COOKIE_NAME] || req.cookies?.auth_token;
  if (fromCookie) return fromCookie;
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  return null;
}

export interface AuthRequest extends Request {
  user?: { id: string; nome_funcionario: string; empresa_id: string; role?: string };
}

export function autenticarToken(req: AuthRequest, res: Response, next: NextFunction) {
  const token = extrairToken(req);
  if (!token) return res.status(401).json({ error: 'Token não fornecido.' });
  try {
    const payload = verifyAccessToken(token);
    req.user = {
      id: String(payload.id),
      nome_funcionario: String(payload.nome_funcionario || ''),
      empresa_id: String(payload.empresa_id || ''),
      role: payload.role,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

export function isAdminUser(user?: { empresa_id?: string; role?: string }): boolean {
  return user?.empresa_id === 'admin' || user?.role === 'admin';
}
