/**
 * JWT + cookies de sessão.
 */
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export const COOKIE_NAME = 'saas_auth_token';
const isProd = process.env.NODE_ENV === 'production';

export function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET ?? '';
  if (!secret) {
    console.error('❌ JWT_SECRET não definido. Defina no backend/.env');
    process.exit(1);
  }
  return secret;
}

export function setAuthCookie(res: Response, token: string) {
  const opts = {
    httpOnly: true,
    secure: isProd,
    sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
  };
  res.cookie(COOKIE_NAME, token, opts);
  res.cookie('auth_token', token, opts);
}

export function clearAuthCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.clearCookie('auth_token', { path: '/' });
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
    const payload = jwt.verify(token, requireJwtSecret()) as any;
    req.user = {
      id: payload.id,
      nome_funcionario: payload.nome_funcionario,
      empresa_id: payload.empresa_id,
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
