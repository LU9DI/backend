/**
 * Filtra.IA — bootstrap da API (produção)
 */
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import 'dotenv/config';
import type { Server } from 'http';

import { assertEnvOrExit } from './lib/env.js';
import { initDB, getDb } from './lib/db.js';
import { requireJwtSecret, setAuthCookie, autenticarToken } from './lib/auth.js';
import { buildCorsOptions } from './lib/cors.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { requestIdMiddleware, securityHeaders } from './middleware/security.js';
import { latencyMiddleware, getHttpMetrics } from './lib/metrics.js';
import { getBuildInfo } from './lib/buildInfo.js';
import { mountHealthRoutes } from './lib/healthMonitor.js';
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
import { mountN8nRoutes } from './routes/n8nRoutes.js';
import { mountPasswordResetRoutes } from './passwordResetRoutes.js';
import { mountAdminLoginRoute } from './adminLoginRoute.js';
import { mountAdminPasswordResetRoutes } from './adminPasswordReset.js';
import { mountMfaRoutes } from './mfa.js';
import { mountStripeRoutes } from './stripeRoutes.js';
import { stripeConfigured, refreshPlanPricesFromDb } from './stripeBilling.js';
import { paypalConfigured } from './lib/paypal.js';
import { mpConfigured } from './lib/mercadopago.js';
import { n8nConfigured, n8nStatus } from './lib/n8n.js';
import { getAiLoadStats } from './groqService.js';
import { ensureUnidadesSchema } from './lib/unidades.js';
import { ensureWebAuthnSchema } from './lib/webauthn.js';
import { ensurePushSchema, initWebPush } from './lib/push.js';
import { ensureAiUsageSchema } from './lib/aiUsage.js';
import { ensureOpsTables } from './lib/opsLog.js';
import { ensureAuditSchema } from './lib/auditLog.js';
import { mountDebugRoutes } from './routes/debugRoutes.js';
import { ensureRetryQueue, startRetryWorker } from './lib/retryQueue.js';
import { registerAllRetryHandlers } from './lib/retryHandlers.js';
import { ensurePlanPricingSchema } from './lib/planPricing.js';
import { ensureRuntimeSchema } from './lib/schemaEnsure.js';
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
app.set('trust proxy', 1);
app.use(requestIdMiddleware);
app.use(securityHeaders);
app.use(cookieParser());
app.use(latencyMiddleware as any);
app.use((req, res, next) => {
  if (req.originalUrl?.startsWith('/api/webhook/stripe')) return next();
  return express.json({ limit: '40kb' })(req, res, next);
});
app.use(cors(buildCorsOptions()));

// live / ready / health (monitoramento)
mountHealthRoutes(app);

app.get('/api/metrics', (req, res) => {
  const secret = process.env.JOBS_SECRET?.trim();
  if (process.env.NODE_ENV === 'production' && secret) {
    const got = String(req.headers['x-jobs-secret'] || '');
    if (got !== secret) {
      return res.status(401).json({ error: 'Não autorizado.' });
    }
  }
  res.json({
    time: new Date().toISOString(),
    build: getBuildInfo(),
    http: getHttpMetrics(),
    ai: getAiLoadStats(),
    n8n: n8nStatus(),
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
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  if (server) {
    server.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
}

async function main() {
  await initDB();

  const boot = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      console.warn(`${label}:`, e);
    }
  };

  await boot('ensureRuntimeSchema', () => ensureRuntimeSchema(getDb()));
  await boot('ensureUnidadesSchema', () => ensureUnidadesSchema(getDb()));
  await boot('ensureWebAuthnSchema', () => ensureWebAuthnSchema(getDb()));
  await boot('ensurePushSchema', async () => {
    await ensurePushSchema(getDb());
    initWebPush();
  });
  await boot('ensureAiUsageSchema', () => ensureAiUsageSchema(getDb()));
  await boot('ensureOpsTables', () => ensureOpsTables(getDb()));
  await boot('ensureAuditSchema', () => ensureAuditSchema(getDb()));
  await boot('plan pricing', async () => {
    await ensurePlanPricingSchema(getDb());
    await refreshPlanPricesFromDb(getDb());
  });
  await boot('retry queue', async () => {
    await ensureRetryQueue(getDb());
    registerAllRetryHandlers();
    startRetryWorker();
  });
  await boot('treatment columns', () => ensureReviewTreatmentColumns(getDb()));

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
  mountN8nRoutes(app);
  mountDebugRoutes(app);

  mountAdminLoginRoute(app, getDb, { setAuthCookie, JWT_SECRET });
  mountAdminPasswordResetRoutes(app, getDb);
  mountMfaRoutes(app, getDb, { JWT_SECRET, setAuthCookie, autenticarToken });
  mountPasswordResetRoutes(app, getDb);
  mountStripeRoutes(app, getDb);

  app.use(notFoundHandler);
  app.use(errorHandler);

  const build = getBuildInfo();
  console.log(`📦 build ${build.version} marker=${build.marker}`);
  console.log(
    `💳 Stripe: ${stripeConfigured() ? 'ok' : 'OFF'} | Pix/MP: ${mpConfigured() ? 'ok' : 'OFF'} | PayPal: ${paypalConfigured() ? 'ok' : 'OFF'} | n8n: ${n8nConfigured() ? 'ok' : 'OFF'}`
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
