/**
 * Filtra.IA — bootstrap da API
 */
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import 'dotenv/config';

import { assertEnvOrExit } from './lib/env.js';
import { initDB, getDb } from './lib/db.js';
import { requireJwtSecret, setAuthCookie, autenticarToken } from './lib/auth.js';
import { buildCorsOptions } from './lib/cors.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { latencyMiddleware, getHttpMetrics } from './lib/metrics.js';
import { mountTrialRoutes } from './routes/trialRoutes.js';
import { mountAuthRoutes } from './routes/authRoutes.js';
import { mountEmpresaRoutes } from './routes/empresaRoutes.js';
import { mountReviewRoutes } from './routes/reviewRoutes.js';
import { mountAdminListRoutes } from './routes/adminListRoutes.js';
import { mountRelatorioRoutes } from './routes/relatorioRoutes.js';
import { mountPasswordResetRoutes } from './passwordResetRoutes.js';
import { mountAdminLoginRoute } from './adminLoginRoute.js';
import { mountAdminPasswordResetRoutes } from './adminPasswordReset.js';
import { mountMfaRoutes } from './mfa.js';
import { mountStripeRoutes } from './stripeRoutes.js';
import { stripeConfigured } from './stripeBilling.js';
import { aiConfigured, listAiProviders, getAiLoadStats } from './groqService.js';
import { ensureUnidadesSchema } from './relatorioPdf.js';

assertEnvOrExit();
const JWT_SECRET = requireJwtSecret();

const app = express();
app.set('trust proxy', 1);
app.use(cookieParser());
app.use(latencyMiddleware as any);
app.use((req, res, next) => {
  if (req.originalUrl?.startsWith('/api/webhook/stripe')) return next();
  return express.json({ limit: '20kb' })(req, res, next);
});
app.use(cors(buildCorsOptions()));

app.get('/api/health', (_req, res) => {
  const ai = getAiLoadStats();
  res.json({
    ok: true,
    stripe: stripeConfigured(),
    ai: aiConfigured(),
    ai_providers: listAiProviders(),
    ai_latency: {
      groq: ai.stats.groq.latency,
      gemini: ai.stats.gemini.latency,
    },
    http_latency: getHttpMetrics().global,
    env: process.env.NODE_ENV || 'development',
    time: new Date().toISOString(),
  });
});

app.get('/api/metrics', (_req, res) => {
  res.json({
    time: new Date().toISOString(),
    http: getHttpMetrics(),
    ai: getAiLoadStats(),
  });
});

const PORT = Number(process.env.PORT || 5000);

async function main() {
  await initDB();
  try {
    await ensureUnidadesSchema(getDb());
  } catch (e) {
    console.warn('ensureUnidadesSchema:', e);
  }

  mountTrialRoutes(app);
  mountAuthRoutes(app);
  mountEmpresaRoutes(app);
  mountReviewRoutes(app);
  mountAdminListRoutes(app);
  mountRelatorioRoutes(app);

  mountAdminLoginRoute(app, getDb, { setAuthCookie, JWT_SECRET });
  mountAdminPasswordResetRoutes(app, getDb);
  mountMfaRoutes(app, getDb, { JWT_SECRET, setAuthCookie, autenticarToken });
  mountPasswordResetRoutes(app, getDb);
  mountStripeRoutes(app, getDb);

  app.use(notFoundHandler);
  app.use(errorHandler);

  const providers = listAiProviders();
  const load = getAiLoadStats();
  console.log(
    `🤖 IA: ${providers.length ? providers.join(' + ') : 'OFF'} | balance=${load.mode}`
  );
  console.log(`💳 Stripe: ${stripeConfigured() ? 'ok' : 'OFF — defina STRIPE_SECRET_KEY no .env'}`);
  app.listen(PORT, () => {
    console.log(`🚀 API Filtra.IA em http://localhost:${PORT}`);
    console.log(`   Health:  http://localhost:${PORT}/api/health`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
