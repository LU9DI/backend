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
import { mountTokenMetricsRoutes } from './routes/tokenMetricsRoutes.js';
import { mountRelatorioRoutes } from './routes/relatorioRoutes.js';
import { mountPlanSwitchRoutes } from './routes/planSwitchRoutes.js';
import { mountWebAuthnRoutes } from './routes/webauthnRoutes.js';
import { mountPushRoutes } from './routes/pushRoutes.js';
import { mountJobsRoutes } from './routes/jobsRoutes.js';
import { mountPayPalRoutes } from './routes/paypalRoutes.js';
import { mountPasswordResetRoutes } from './passwordResetRoutes.js';
import { mountAdminLoginRoute } from './adminLoginRoute.js';
import { mountAdminPasswordResetRoutes } from './adminPasswordReset.js';
import { mountMfaRoutes } from './mfa.js';
import { mountStripeRoutes } from './stripeRoutes.js';
import { stripeConfigured } from './stripeBilling.js';
import { paypalConfigured } from './lib/paypal.js';
import { aiConfigured, listAiProviders, getAiLoadStats } from './groqService.js';
import { ensureUnidadesSchema } from './relatorioPdf.js';
import { ensureWebAuthnSchema, webauthnConfig } from './lib/webauthn.js';
import { ensurePushSchema, pushConfigured, initWebPush } from './lib/push.js';
import { ensureAiUsageSchema } from './lib/aiUsage.js';
import { ensureOpsTables } from './lib/opsLog.js';
import { ensureRetryQueue, startRetryWorker } from './lib/retryQueue.js';
import { registerAllRetryHandlers } from './lib/retryHandlers.js';
import { allowPlanSwitch } from './lib/plans.js';
import { smtpConfigured } from './lib/mailer.js';
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
  return express.json({ limit: '20kb' })(req, res, next);
});
app.use(cors(buildCorsOptions()));

app.get('/api/health', (_req, res) => {
  const ai = getAiLoadStats();
  res.json({
    ok: true,
    stripe: stripeConfigured(),
    paypal: paypalConfigured(),
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

async function runSentimentBackfillOnBoot() {
  if (process.env.BACKFILL_SENTIMENT === '0') {
    console.log('⏭️  Backfill de sentimento desligado (BACKFILL_SENTIMENT=0)');
    return;
  }
  try {
    const db = getDb();
    const missing = await countMissingSentiment(db);
    if (missing === 0) {
      console.log('✅ Sentimento: nenhuma review pendente de backfill');
      return;
    }
    const limit = Math.max(1, Number(process.env.BACKFILL_SENTIMENT_LIMIT || 2000));
    console.log(`🧠 Backfill sentimento: ${missing} pendente(s), processando até ${limit}…`);
    const r = await backfillSentiment(db, {
      limit,
      useAi: process.env.BACKFILL_SENTIMENT_AI === '1',
    });
    console.log(
      `🧠 Backfill sentimento: updated=${r.updated} errors=${r.errors} em ${r.duration_ms}ms`
    );
  } catch (e: any) {
    console.warn('Backfill sentimento (não bloqueia boot):', e?.message || e);
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
    await ensureRetryQueue(getDb());
    registerAllRetryHandlers();
    startRetryWorker();
  } catch (e) {
    console.warn('retry queue:', e);
  }

  await runSentimentBackfillOnBoot();

  mountTrialRoutes(app);
  mountAuthRoutes(app);
  mountEmpresaRoutes(app);
  mountReviewRoutes(app);
  mountAdminDashboardRoutes(app);
  mountAdminTecnicoRoutes(app);
  mountTokenMetricsRoutes(app);
  mountRelatorioRoutes(app);
  mountPlanSwitchRoutes(app);
  mountWebAuthnRoutes(app);
  mountPushRoutes(app);
  mountJobsRoutes(app);
  mountPayPalRoutes(app);

  mountAdminLoginRoute(app, getDb, { setAuthCookie, JWT_SECRET });
  mountAdminPasswordResetRoutes(app, getDb);
  mountMfaRoutes(app, getDb, { JWT_SECRET, setAuthCookie, autenticarToken });
  mountPasswordResetRoutes(app, getDb);
  mountStripeRoutes(app, getDb);

  app.use(notFoundHandler);
  app.use(errorHandler);

  const providers = listAiProviders();
  const load = getAiLoadStats();
  const jwtStat = jwtRotationStatus();
  console.log(
    `🤖 IA: ${providers.length ? providers.join(' + ') : 'OFF'} | balance=${load.mode}`
  );
  console.log(
    `🔐 JWT kid=${jwtStat.kid} keys_verify=${jwtStat.keys_for_verify} previous=${jwtStat.has_previous}`
  );
  console.log(
    `👆 WebAuthn rp=${webauthnConfig().rpId} origin=${webauthnConfig().origin}`
  );
  console.log(`🔔 Push: ${pushConfigured() ? 'ON (VAPID)' : 'OFF — npx web-push generate-vapid-keys'}`);
  console.log(`📧 SMTP: ${smtpConfigured() ? 'ON' : 'OFF — e-mails vão para o console em dev'}`);
  console.log(
    `🧪 Troca de plano (teste): ${allowPlanSwitch() ? 'ON' : 'OFF'} — ALLOW_PLAN_SWITCH`
  );
  console.log(`💳 Stripe: ${stripeConfigured() ? 'ok' : 'OFF'}`);
  console.log(
    `💳 PayPal: ${paypalConfigured() ? 'ok (' + (process.env.PAYPAL_MODE || 'sandbox') + ')' : 'OFF — PAYPAL_CLIENT_ID/SECRET'}`
  );
  app.listen(PORT, () => {
    console.log(`🚀 API Filtra.IA em http://localhost:${PORT}`);
    console.log(`   Health:  http://localhost:${PORT}/api/health`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
