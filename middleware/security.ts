/**
 * Headers de segurança + correlation / request id.
 */
import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming =
    String(req.headers['x-request-id'] || '').trim() ||
    String(req.headers['x-correlation-id'] || '').trim();
  const id = incoming || crypto.randomUUID();
  (req as any).requestId = id;
  (req as any).correlationId = id;
  res.setHeader('X-Request-Id', id);
  res.setHeader('X-Correlation-Id', id);
  next();
}

/** Log estruturado mínimo por request (produção: só 4xx/5xx ou REQUEST_LOG=1). */
export function requestLogMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    const status = res.statusCode;
    const verbose = process.env.REQUEST_LOG === '1' || process.env.NODE_ENV !== 'production';
    if (!verbose && status < 400) return;
    const line = {
      level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
      msg: 'http',
      method: req.method,
      path: req.originalUrl || req.url,
      status,
      ms: Date.now() - start,
      request_id: (req as any).requestId || null,
    };
    if (status >= 500) console.error(JSON.stringify(line));
    else if (status >= 400) console.warn(JSON.stringify(line));
    else console.log(JSON.stringify(line));
  });
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
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}
