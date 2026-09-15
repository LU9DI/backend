/**
 * Rate limiting em rotas públicas / auth / webhooks.
 */
import type { Express, Request } from 'express';
import rateLimit from 'express-rate-limit';

export function mountPublicRateLimit(app: Express) {
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
      if (p === '/api/live' || p === '/api/ready' || p === '/api/health') return true;
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
  app.use('/api/trial/', authLimiter);

  console.log(
    `🛡️  Rate limit: ${max}/${Math.round(windowMs / 1000)}s | auth=${process.env.RATE_LIMIT_AUTH_MAX || 40}/15m | webhook=${process.env.RATE_LIMIT_WEBHOOK_MAX || 300}/min`
  );
}
