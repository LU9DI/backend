/**
 * Filtra.AI API — bootstrap estável (cold start rápido no Render).
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

mountHealthRoutes(app);

app.get('/api/metrics', (req, res) => {
  const secret = process.env.JOBS_SECRET?.trim();
  if (process.env.NODE_ENV === 'production' && secret) {
    if (String(req.headers['x-jobs-secret'] || '') !== secret) {
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

async function bootSafe(label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e: any) {
    console.warn(`[boot] ${label}:`, e?.message || e);
  }
}

/** Trabalho pesado depois do listen — cold start mais rápido. */
async function backgroundBoot() {
  await bootSafe('unidades', () => ensureUnidadesSchema(getDb()));
  await bootSafe('webauthn', () => ensureWebAuthnSchema(getDb()));
  await bootSafe('push', async () => {
    await ensurePushSchema(getDb());
    initWebPush();
  });
  await bootSafe('aiUsage', () => ensureAiUsageSchema(getDb()));
  await bootSafe('ops', () => ensureOpsTables(getDb()));
  await bootSafe('audit', () => ensureAuditSchema(getDb()));
  await bootSafe('plan pricing', async () => {
    await ensurePlanPricingSchema(getDb());
    await refreshPlanPricesFromDb(getDb());
  });
  await bootSafe('retry', async () => {
    await ensureRetryQueue(getDb());
    registerAllRetryHandlers();
    startRetryWorker();
  });
  await bootSafe('treatment', () => ensureReviewTreatmentColumns(getDb()));

  if (process.env.BACKFILL_SENTIMENT === '1') {
    await bootSafe('sentiment', async () => {
      const missing = await countMissingSentiment(getDb());
      if (missing === 0) return;
      const limit = Math.max(1, Number(process.env.BACKFILL_SENTIMENT_LIMIT || 500));
      await backfillSentiment(getDb(), { limit, useAi: false });
    });
  }

  if (process.env.LGPD_SWEEP === '1') {
    await bootSafe('lgpd', async () => {
      await ensureReviewTreatmentColumns(getDb());
      await anonymizeOldClientWhatsapp(getDb(), { limit: 500 });
    });
  }
}

/** Self-ping opcional (além do UptimeRobot). */
function startSelfKeepAlive() {
  const url = (process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
  if (!url) return;
  const target = url.replace(/\/$/, '') + '/api/live';
  const ms = Math.max(4 * 60_000, Number(process.env.KEEP_ALIVE_MS || 5 * 60_000));
  const tick = async () => {
    try {
      await fetch(target, { signal: AbortSignal.timeout(8_000) });
    } catch {
      /* ignore */
    }
  };
  setInterval(tick, ms).unref();
  setTimeout(tick, 30_000).unref();
  console.log(`💓 keep-alive → ${target} a cada ${Math.round(ms / 1000)}s`);
}

function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`⏹  ${signal}`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
}

async function main() {
  // DB + schema mínimo ANTES de escutar
  await initDB();
  await bootSafe('runtimeSchema', () => ensureRuntimeSchema(getDb()));

  // Rotas críticas já disponíveis no cold start
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

  mountAdminLoginRoute(app, getDb, { setAuthCookie, JWT_SECRET });
  mountAdminPasswordResetRoutes(app, getDb);
  mountMfaRoutes(app, getDb, { JWT_SECRET, setAuthCookie, autenticarToken });
  mountPasswordResetRoutes(app, getDb);
  mountStripeRoutes(app, getDb);

  app.use(notFoundHandler);
  app.use(errorHandler);

  const build = getBuildInfo();
  console.log(`📦 ${build.version} ${build.marker}`);
  console.log(
    `💳 Stripe: ${stripeConfigured() ? 'ok' : 'OFF'} | MP: ${mpConfigured() ? 'ok' : 'OFF'} | PayPal: ${paypalConfigured() ? 'ok' : 'OFF'} | n8n: ${n8nConfigured() ? 'ok' : 'OFF'}`
  );

  server = app.listen(PORT, () => {
    console.log(`🚀 Filtra.AI :${PORT}`);
  });

  // Evita timeouts prematuros atrás do proxy do Render
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // Não bloqueia o listen
  setImmediate(() => {
    backgroundBoot().catch((e) => console.warn('backgroundBoot', e));
  });

  startSelfKeepAlive();

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  process.on('unhandledRejection', (reason: any) => {
    console.error('unhandledRejection:', reason?.message || reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('uncaughtException:', err?.message || err);
    // Em produção, tenta graceful em vez de morrer silencioso
    if (process.env.NODE_ENV === 'production') {
      gracefulShutdown('uncaughtException');
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
