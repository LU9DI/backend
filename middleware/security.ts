/**
 * Headers de segurança + request id (sem dependência helmet pesada).
 */
import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { isProductionRuntime } from '../lib/env.js';



export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = String(req.headers['x-request-id'] || '').trim();
  const id = incoming || crypto.randomUUID();
  (req as any).requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()'
  );
  // API JSON — CSP restritiva no próprio browser do client é do Next; aqui só API
  if (isProductionRuntime()) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}
