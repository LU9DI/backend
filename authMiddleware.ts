/**
 * Middleware de autenticação JWT.
 * Cookie: auth_token (também aceita saas_auth_token legado)
 * Header: Authorization: Bearer <token>
 */
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email?: string;
    empresa_id?: string;
    role?: string;
    nome_funcionario?: string;
  };
}

export function extrairToken(req: Request, cookieName = 'auth_token'): string | null {
  const fromCookie =
    req.cookies?.auth_token ||
    req.cookies?.[cookieName] ||
    req.cookies?.saas_auth_token;
  if (fromCookie) return fromCookie;

  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  if (authHeader && !authHeader.includes(' ')) return authHeader;
  return null;
}

export function makeAutenticarToken(JWT_SECRET: string, cookieName = 'auth_token') {
  return function autenticarToken(req: AuthRequest, res: Response, next: NextFunction) {
    const token = extrairToken(req, cookieName);
    if (!token) {
      return res.status(401).json({ error: 'Token não fornecido.' });
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as {
        id: string;
        email?: string;
        empresa_id?: string;
        role?: string;
        nome_funcionario?: string;
      };
      req.user = decoded;
      next();
    } catch {
      return res.status(401).json({ error: 'Token inválido ou expirado.' });
    }
  };
}

export function makeSetAuthCookie(isProd: boolean, cookieName = 'auth_token') {
  return function setAuthCookie(res: Response, token: string) {
    res.cookie(cookieName, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/',
    });
  };
}

export function makeClearAuthCookie(isProd: boolean, cookieName = 'auth_token') {
  return function clearAuthCookie(res: Response) {
    res.clearCookie(cookieName, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      path: '/',
    });
  };
}

