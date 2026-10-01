/**
 * JWT + cookies de sessão (com rotação de chave).
 */
import type { Request, Response, NextFunction } from 'express';
import {
  requireJwtSecret as _require,
  signAccessToken,
  verifyAccessToken,
  type JwtPayload,
} from './jwtKeys.js';
import { getDb } from './db.js';
import { empresaTemAcesso } from '../services/billingService.js';

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

export async function autenticarToken(req: AuthRequest, res: Response, next: NextFunction) {
  const token = extrairToken(req);
  if (!token) {
    return res.status(401).json({
      error: 'Faça login com e-mail e senha para acessar o painel.',
      code: 'AUTH_REQUIRED',
    });
  }
  try {
    const payload = verifyAccessToken(token);

    // O JWT é necessário, mas não é suficiente: o estado atual da empresa
    // continua sendo a fonte de verdade. Cancelamento no fim do período
    // permanece ativo enquanto expira_em estiver no futuro.
    if (!isAdminPayload(payload)) {
      const db = getDb();
      const empresa = await db.get(
        'SELECT status, expira_em FROM empresas WHERE id = ?',
        [payload.empresa_id]
      );
      if (!empresa || !empresaTemAcesso(empresa)) {
        return res.status(401).json({
          error: 'Sua assinatura não está ativa. Faça uma nova contratação para continuar.',
          code: 'SUBSCRIPTION_INACTIVE',
        });
      }
    }

    req.user = {
      id: payload.id,
      nome_funcionario: payload.nome_funcionario,
      empresa_id: payload.empresa_id,
      role: payload.role,
    };
    return next();
  } catch {
    return res.status(401).json({
      error: 'Sessão expirada. Faça login novamente.',
      code: 'TOKEN_EXPIRED',
    });
  }
}

function isAdminPayload(payload?: { empresa_id?: string; role?: string }): boolean {
  return payload?.empresa_id === 'admin' || payload?.role === 'admin';
}


/** Valida vínculo quando um endpoint público recebe empresa_id explicitamente. */
export function empresaInformadaPertenceAoToken(req: Request, empresaId: string): boolean {
  const token = extrairToken(req);
  if (!token) return false;
  try {
    const payload = verifyAccessToken(token);
    return payload.empresa_id === 'admin' || payload.role === 'admin' || String(payload.empresa_id || '') === String(empresaId);
  } catch {
    return false;
  }
}

export function isAdminUser(user?: { empresa_id?: string; role?: string }): boolean {
  return user?.empresa_id === 'admin' || user?.role === 'admin';
}
