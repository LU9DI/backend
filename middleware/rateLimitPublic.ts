/**
 * Rate limiting em rotas públicas (anti abuso / DDoS leve).
 * Usa express-rate-limit se disponível.
 */
import type { Express, Request, Response, NextFunction } from 'express';

export function mountPublicRateLimit(app: Express) {
  let rateLimit: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    rateLimit = require('express-rate-limit').default || require('express-rate-limit');
  } catch {
    console.warn('⚠️  express-rate-limit ausente — rate limit global OFF');
    return;
  }

  const windowMs = Math.max(10_000, Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000));
  const max = Math.max(30, Number(process.env.RATE_LIMIT_MAX || 180));

  const globalLimiter = rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Muitas requisições. Aguarde um momento.' },
    skip: (req: Request) => {
      const p = req.path || '';
      // health/live/ready nunca limitados (UptimeRobot / Render)
      if (p === '/api/live' || p === '/api/ready' || p === '/api/health') return true;
      // webhooks de pagamento: limite separado mais alto
      if (p.startsWith('/api/webhook/')) return true;
      return false;
    },
  });

  const webhookLimiter = rateLimit({
    windowMs: 60_000,
    max: Math.max(60, Number(process.env.RATE_LIMIT_WEBHOOK_MAX || 300)),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Webhook rate limit.' },
  });

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Math.max(20, Number(process.env.RATE_LIMIT_AUTH_MAX || 40)),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Muitas tentativas de login. Aguarde.' },
  });

  app.use('/api/', globalLimiter);
  app.use('/api/webhook/', webhookLimiter);
  app.use('/api/auth/', authLimiter);
  app.use('/api/admin/login', authLimiter);

  console.log(
    `🛡️  Rate limit: ${max} req/${Math.round(windowMs / 1000)}s (público), webhooks e auth separados`
  );
}
