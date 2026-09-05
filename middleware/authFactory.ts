/**
 * Factory de middleware JWT (legado de authMiddleware.ts).
 * Preferir lib/auth.ts para cookies unificados (SameSite=None em prod).
 */
export {
  extrairToken,
  type AuthRequest,
} from '../lib/auth.js';

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { AuthRequest } from '../lib/auth.js';

export function makeAutenticarToken(JWT_SECRET: string, _cookieName = 'auth_token') {
  return function autenticarToken(req: AuthRequest, res: Response, next: NextFunction) {
    const fromCookie =
      req.cookies?.auth_token || req.cookies?.saas_auth_token;
    const authHeader = req.headers['authorization'];
    const token =
      fromCookie ||
      (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);
    if (!token) return res.status(401).json({ error: 'Token não fornecido.' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      req.user = decoded;
      next();
    } catch {
      return res.status(401).json({ error: 'Token inválido ou expirado.' });
    }
  };
}
