/**
 * Filtra.IA — bootstrap da API (produção-ready)
 */
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import 'dotenv/config';
import type { Server } from 'http';

import { assertEnvOrExit } from './lib/env.js';
import { initDB, getDb, dbEngine, pingDb } from './lib/db.js';
import { requireJwtSecret, setAuthCookie, autenticarToken } from './lib/auth.js';
import { jwtRotationStatus } from './lib/jwtKeys.js';
import { buildCorsOptions } from './lib/cors.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { requestIdMiddleware, securityHeaders } from './middleware/security.js';
import { latencyMiddleware, getHttpMetrics } from './lib/metrics.js';
import { mountTrialRoutes } from './routes/trialRoutes.js';
import { mountAuthRoutes } from './routes/authRoutes.js';
import { mountEmpresaRoutes } from './routes/empresaRoutes.js';
import { mountReviewRoutes } from './routes/reviewRoutes.js';
import { mountAdminDashboardRoutes } from './routes/adminDashboardRoutes.js';
import { mountAdminTecnicoRoutes } from './routes/adminTecnicoRoutes.js';
import { mountAdminNegocioRoutes } from './routes/adminNegocioRoutes.js';
import { mountTokenMetricsRoutes } from './routes/tokenMetricsRoutes.js';
import { mountRelatorioRoutes } from './routes/relatorioRoutes.js';
import { mountPlanSwitchRoutes } from './routes/planSwitchRoutes.js';
import { mountWebAuthnRoutes } from './routes/webauthnRoutes.js';
import { mountPushRoutes } from './routes/pushRoutes.js';
import { mountJobsRoutes } from './routes/jobsRoutes.js';
import { mountPayPalRoutes } from './routes/paypalRoutes.js';
import { mountPixRoutes } from './routes/pixRoutes.js';
import { mountSubscriptionRoutes } from './routes/subscriptionRoutes.js';
import { mountUnidadeRoutes } from './routes/unidadeRoutes.js';
import { mountExportRoutes } from './routes/exportRoutes.js';
import { mountPublicPlanosRoutes } from './routes/publicPlanosRoutes.js';
import { mountAuditRoutes } from './routes/auditRoutes.js';
import { mountPasswordResetRoutes } from './passwordResetRoutes.js';
import { mountAdminLoginRoute } from './adminLoginRoute.js';
import { mountAdminPasswordResetRoutes } from './adminPasswordReset.js';
import { mountMfaRoutes } from './mfa.js';
import { mountStripeRoutes } from './stripeRoutes.js';
import { mountN8nRoutes } from './routes/n8nRoutes.js';
import { stripeConfigured, refreshPlanPricesFromDb } from './stripeBilling.js';
import { paypalConfigured } from './lib/paypal.js';
import { mpConfigured } from './lib/mercadopago.js';
import { aiConfigured, listAiProviders, getAiLoadStats } from './groqService.js';
import { ensureUnidadesSchema } from './lib/unidades.js';
import { ensureWebAuthnSchema, webauthnConfig } from './lib/webauthn.js';
import { ensurePushSchema, pushConfigured, initWebPush } from './lib/push.js';
import { ensureAiUsageSchema } from './lib/aiUsage.js';
import { ensureOpsTables } from './lib/opsLog.js';
import { ensureAuditSchema } from './lib/auditLog.js';
import { ensureRetryQueue, startRetryWorker } from './lib/retryQueue.js';
import { registerAllRetryHandlers } from './lib/retryHandlers.js';
import { ensurePlanPricingSchema } from './lib/planPricing.js';
import { allowPlanSwitch } from './lib/plans.js';
import { smtpConfigured } from './lib/mailer.js';
import {
  anonymizeOldClientWhatsapp,
  ensureReviewTreatmentColumns,
} from './lib/lgpd.js';
import {
  backfillSentiment,
  countMissingSentiment,
} from './services/sentimentBackfill.js';

assertEnvOrExit();
const JWT_SECRET = requireJwtSecret();

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const metricsToken = process.env.METRICS_TOKEN?.trim();
app.set('trust proxy', 1);
app.use(requestIdMiddleware);
app.use(securityHeaders);
app.use(cookieParser());
app.use(latencyMiddleware as any);
app.use((req, res, next) => {
  if (req.originalUrl?.startsWith('/api/webhook/stripe')) return next();
  return express.json({ limit: '20kb' })(req, res, next);
});
app.use(cors(buildCorsOptions()));

/** Health com ping real no banco — Render usa para saber se o serviço está vivo. */
app.get('/api/health', async (_req, res) => {
  const ai = getAiLoadStats();
  let dbPing: { ok: boolean; engine: string; error?: string } = {
    ok: false,
    engine: 'unknown',
  };
  try {
    dbPing = await pingDb();
  } catch (e: any) {
    dbPing = { ok: false, engine: 'unknown', error: String(e?.message || e) };
  }

  const body = {
    ok: dbPing.ok,
    db: dbPing.engine || (typeof dbEngine === 'function' ? dbEngine() : 'sqlite'),
    db_ok: dbPing.ok,
    stripe: stripeConfigured(),
    paypal: paypalConfigured(),
    pix: mpConfigured(),
    ai: aiConfigured(),
    ai_providers: listAiProviders(),
    plan_switch: allowPlanSwitch(),
    jwt: jwtRotationStatus(),
    webauthn: webauthnConfig(),
    push: pushConfigured(),
    smtp: smtpConfigured(),
    ai_latency: {
      groq: ai.stats.groq.latency,
      gemini: ai.stats.gemini.latency,
    },
    http_latency: getHttpMetrics().global,
    env: process.env.NODE_ENV || 'development',
    time: new Date().toISOString(),
  };

  res.status(dbPing.ok ? 200 : 503).json(body);
});

app.get('/api/metrics', (req, res) => {
  if (isProduction && (!metricsToken || req.get('x-metrics-token') !== metricsToken)) {
    return res.status(404).end();
  }
  res.json({
    time: new Date().toISOString(),
    http: getHttpMetrics(),
    ai: getAiLoadStats(),
  });
});

const PORT = Number(process.env.PORT || 5000);
let server: Server | null = null;
let shuttingDown = false;

async function runSentimentBackfillOnBoot() {
  if (process.env.BACKFILL_SENTIMENT === '0') return;
  try {
    const db = getDb();
    const missing = await countMissingSentiment(db);
    if (missing === 0) return;
    const limit = Math.max(1, Number(process.env.BACKFILL_SENTIMENT_LIMIT || 2000));
    const r = await backfillSentiment(db, {
      limit,
      useAi: process.env.BACKFILL_SENTIMENT_AI === '1',
    });
    console.log(`🧠 Backfill sentimento: updated=${r.updated} errors=${r.errors}`);
  } catch (e: any) {
    console.warn('Backfill sentimento:', e?.message || e);
  }
}

async function runLgpdSweepOnBoot() {
  if (process.env.LGPD_SWEEP === '0') return;
  try {
    const db = getDb();
    await ensureReviewTreatmentColumns(db);
    await anonymizeOldClientWhatsapp(db, { limit: 1000 });
  } catch (e: any) {
    console.warn('LGPD sweep:', e?.message || e);
  }
}

function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`⏹  ${signal} — encerrando...`);
  const force = setTimeout(() => {
    console.error('Force exit após timeout de shutdown');
    process.exit(1);
  }, 10_000);
  force.unref();

  if (server) {
    server.close(() => {
      console.log('HTTP fechado.');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

async function main() {
  await initDB();
  try {
    await ensureUnidadesSchema(getDb());
  } catch (e) {
    console.warn('ensureUnidadesSchema:', e);
  }
  try {
    await ensureWebAuthnSchema(getDb());
  } catch (e) {
    console.warn('ensureWebAuthnSchema:', e);
  }
  try {
    await ensurePushSchema(getDb());
    initWebPush();
  } catch (e) {
    console.warn('ensurePushSchema:', e);
  }
  try {
    await ensureAiUsageSchema(getDb());
  } catch (e) {
    console.warn('ensureAiUsageSchema:', e);
  }
  try {
    await ensureOpsTables(getDb());
  } catch (e) {
    console.warn('ensureOpsTables:', e);
  }
  try {
    await ensureAuditSchema(getDb());
  } catch (e) {
    console.warn('ensureAuditSchema:', e);
  }
  try {
    await ensurePlanPricingSchema(getDb());
    await refreshPlanPricesFromDb(getDb());
  } catch (e) {
    console.warn('plan pricing:', e);
  }
  try {
    await ensureRetryQueue(getDb());
    registerAllRetryHandlers();
    startRetryWorker();
  } catch (e) {
    console.warn('retry queue:', e);
  }
  try {
    await ensureReviewTreatmentColumns(getDb());
  } catch (e) {
    console.warn('treatment columns:', e);
  }

  await runSentimentBackfillOnBoot();
  await runLgpdSweepOnBoot();

  mountTrialRoutes(app);
  mountAuthRoutes(app);
  mountEmpresaRoutes(app);
  mountReviewRoutes(app);
  mountAdminDashboardRoutes(app);
  mountAdminTecnicoRoutes(app);
  mountAdminNegocioRoutes(app);
  mountTokenMetricsRoutes(app);
  mountRelatorioRoutes(app);
  mountPlanSwitchRoutes(app);
  mountWebAuthnRoutes(app);
  mountPushRoutes(app);
  mountJobsRoutes(app);
  mountPayPalRoutes(app);
  mountPixRoutes(app);
  mountSubscriptionRoutes(app);
  mountUnidadeRoutes(app);
  mountExportRoutes(app);
  mountPublicPlanosRoutes(app);
  mountAuditRoutes(app);

  mountAdminLoginRoute(app, getDb, { setAuthCookie, JWT_SECRET });
  mountAdminPasswordResetRoutes(app, getDb);
  mountMfaRoutes(app, getDb, { JWT_SECRET, setAuthCookie, autenticarToken });
  mountPasswordResetRoutes(app, getDb);
  mountStripeRoutes(app, getDb);
  mountN8nRoutes(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  console.log(
    `💳 Stripe: ${stripeConfigured() ? 'ok' : 'OFF'} | Pix: ${mpConfigured() ? 'ok' : 'OFF'} | PayPal: ${paypalConfigured() ? 'ok' : 'OFF'}`
  );

  server = app.listen(PORT, () => {
    console.log(`🚀 API Filtra.IA em http://localhost:${PORT}`);
  });

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
