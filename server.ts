/**
 * Filtra.IA — bootstrap resiliente.
 * Princípio: módulo periférico OFF ≠ API morta.
 */
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import 'dotenv/config';
import type { Server } from 'http';

import { assertEnvOrExit } from './lib/env.js';
import { initDB, getDb, dbEngine, pingDb } from './lib/db.js';
import { requireJwtSecret, setAuthCookie, autenticarToken } from './lib/auth.js';
import { buildCorsOptions } from './lib/cors.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { requestIdMiddleware, securityHeaders } from './middleware/security.js';
import { latencyMiddleware, getHttpMetrics } from './lib/metrics.js';
import {
  safeMount,
  safeImportMount,
  installProcessGuards,
  getMountResults,
} from './lib/safeMount.js';
import {
  applyPublicRateLimit,
  ensureWebhookDedupe,
  initObservability,
} from './lib/bootExtras.js';

installProcessGuards();
assertEnvOrExit();
const JWT_SECRET = requireJwtSecret();

const BUILD = {
  version: '1.3.1',
  marker: 'ops-rate-limit-retry-v1',
  started_at: new Date().toISOString(),
};

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

app.get('/api/live', (_req, res) => {
  res.status(200).json({ ok: true, live: true, build: BUILD, time: new Date().toISOString() });
});

app.get('/api/ready', async (_req, res) => {
  try {
    const dbPing = await pingDb();
    if (!dbPing.ok) {
      return res.status(503).json({ ok: false, ready: false, db: dbPing, build: BUILD });
    }
    res.status(200).json({ ok: true, ready: true, db: dbPing, build: BUILD });
  } catch (e: any) {
    res.status(503).json({
      ok: false,
      ready: false,
      error: String(e?.message || e),
      build: BUILD,
    });
  }
});

function envOn(...keys: string[]): boolean {
  return keys.some((k) => Boolean(String(process.env[k] || '').trim()));
}

app.get('/api/health', async (_req, res) => {
  let dbPing: { ok: boolean; engine: string; error?: string } = {
    ok: false,
    engine: 'unknown',
  };
  try {
    dbPing = await pingDb();
  } catch (e: any) {
    dbPing = { ok: false, engine: 'unknown', error: String(e?.message || e) };
  }

  let aiLatency: any = {};
  try {
    const { getAiLoadStats } = await import('./groqService.js');
    const ai = getAiLoadStats();
    aiLatency = { groq: ai.stats.groq.latency, gemini: ai.stats.gemini.latency };
  } catch {
    aiLatency = {};
  }

  const body = {
    ok: dbPing.ok,
    db: dbPing.engine || (typeof dbEngine === 'function' ? dbEngine() : 'unknown'),
    db_ok: dbPing.ok,
    build: BUILD,
    modules: getMountResults(),
    stripe: envOn('STRIPE_SECRET_KEY'),
    paypal: envOn('PAYPAL_CLIENT_ID') && envOn('PAYPAL_CLIENT_SECRET'),
    pix: envOn('MP_ACCESS_TOKEN'),
    wechat: envOn('WECHAT_APP_ID') && envOn('WECHAT_MCH_ID'),
    ai: envOn('GROQ_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'),
    push: envOn('VAPID_PUBLIC_KEY') && envOn('VAPID_PRIVATE_KEY'),
    smtp: envOn('SMTP_HOST') && envOn('SMTP_FROM'),
    n8n: envOn('N8N_WEBHOOK_URL'),
    sentry: envOn('SENTRY_DSN'),
    plan_switch: String(process.env.ALLOW_PLAN_SWITCH || '') === '1',
    ai_latency: aiLatency,
    http_latency: getHttpMetrics().global,
    env: process.env.NODE_ENV || 'development',
    time: new Date().toISOString(),
  };

  res.status(dbPing.ok ? 200 : 503).json(body);
});

app.get('/api/metrics', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    const secret = (process.env.METRICS_TOKEN || process.env.JOBS_SECRET || '').trim();
    const got = String(req.headers['x-metrics-token'] || req.headers['x-jobs-secret'] || '');
    if (!secret || got !== secret) {
      return res.status(401).json({ error: 'Não autorizado.' });
    }
  }
  res.json({
    time: new Date().toISOString(),
    build: BUILD,
    modules: getMountResults(),
    http: getHttpMetrics(),
  });
});

const PORT = Number(process.env.PORT || 5000);
let server: Server | null = null;
let shuttingDown = false;

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

async function schemaSafe(name: string, fn: () => Promise<void>) {
  await safeMount(`schema:${name}`, fn);
}

async function main() {
  // Observabilidade + rate limit ANTES das rotas de negócio
  await applyPublicRateLimit(app);
  await initObservability(app);

  await initDB();
  console.log(`🐘 DB engine=${typeof dbEngine === 'function' ? dbEngine() : '?'}`);
  await ensureWebhookDedupe();

  await schemaSafe('unidades', async () => {
    const { ensureUnidadesSchema } = await import('./lib/unidades.js');
    await ensureUnidadesSchema(getDb());
  });
  await schemaSafe('webauthn', async () => {
    const { ensureWebAuthnSchema } = await import('./lib/webauthn.js');
    await ensureWebAuthnSchema(getDb());
  });
  await schemaSafe('push', async () => {
    const push = await import('./lib/push.js');
    await push.ensurePushSchema(getDb());
    try {
      push.initWebPush();
    } catch (e: any) {
      console.warn('initWebPush:', e?.message || e);
    }
  });
  await schemaSafe('ai_usage', async () => {
    const { ensureAiUsageSchema } = await import('./lib/aiUsage.js');
    await ensureAiUsageSchema(getDb());
  });
  await schemaSafe('ops', async () => {
    const { ensureOpsTables } = await import('./lib/opsLog.js');
    await ensureOpsTables(getDb());
  });
  await schemaSafe('audit', async () => {
    const { ensureAuditSchema } = await import('./lib/auditLog.js');
    await ensureAuditSchema(getDb());
  });
  await schemaSafe('plan_pricing', async () => {
    const { ensurePlanPricingSchema } = await import('./lib/planPricing.js');
    await ensurePlanPricingSchema(getDb());
    try {
      const { refreshPlanPricesFromDb } = await import('./stripeBilling.js');
      await refreshPlanPricesFromDb(getDb());
    } catch (e: any) {
      console.warn('refreshPlanPrices:', e?.message || e);
    }
  });
  await schemaSafe('retry_queue', async () => {
    const rq = await import('./lib/retryQueue.js');
    await rq.ensureRetryQueue(getDb());
    try {
      const { registerAllRetryHandlers } = await import('./lib/retryHandlers.js');
      registerAllRetryHandlers();
    } catch (e: any) {
      console.warn('retryHandlers:', e?.message || e);
    }
    try {
      rq.startRetryWorker();
    } catch (e: any) {
      console.warn('retryWorker:', e?.message || e);
    }
  });
  await schemaSafe('lgpd_cols', async () => {
    const { ensureReviewTreatmentColumns } = await import('./lib/lgpd.js');
    await ensureReviewTreatmentColumns(getDb());
  });

  void (async () => {
    if (process.env.BACKFILL_SENTIMENT === '1') {
      try {
        const s = await import('./services/sentimentBackfill.js');
        const missing = await s.countMissingSentiment(getDb());
        if (missing > 0) {
          const r = await s.backfillSentiment(getDb(), {
            limit: Math.max(1, Number(process.env.BACKFILL_SENTIMENT_LIMIT || 500)),
            useAi: process.env.BACKFILL_SENTIMENT_AI === '1',
          });
          console.log(`🧠 Backfill sentimento: updated=${r.updated}`);
        }
      } catch (e: any) {
        console.warn('Backfill sentimento:', e?.message || e);
      }
    }
    if (process.env.LGPD_SWEEP === '1') {
      try {
        const l = await import('./lib/lgpd.js');
        await l.anonymizeOldClientWhatsapp(getDb(), { limit: 1000 });
      } catch (e: any) {
        console.warn('LGPD sweep:', e?.message || e);
      }
    }
  })();

  await safeImportMount('trial', () => import('./routes/trialRoutes.js'), 'mountTrialRoutes', app);
  await safeImportMount('auth', () => import('./routes/authRoutes.js'), 'mountAuthRoutes', app);
  await safeImportMount('empresa', () => import('./routes/empresaRoutes.js'), 'mountEmpresaRoutes', app);
  await safeImportMount('review', () => import('./routes/reviewRoutes.js'), 'mountReviewRoutes', app);

  await safeImportMount('adminDashboard', () => import('./routes/adminDashboardRoutes.js'), 'mountAdminDashboardRoutes', app);
  await safeImportMount('adminTecnico', () => import('./routes/adminTecnicoRoutes.js'), 'mountAdminTecnicoRoutes', app);
  await safeImportMount('adminNegocio', () => import('./routes/adminNegocioRoutes.js'), 'mountAdminNegocioRoutes', app);
  await safeImportMount('tokenMetrics', () => import('./routes/tokenMetricsRoutes.js'), 'mountTokenMetricsRoutes', app);
  await safeImportMount('relatorio', () => import('./routes/relatorioRoutes.js'), 'mountRelatorioRoutes', app);
  await safeImportMount('planSwitch', () => import('./routes/planSwitchRoutes.js'), 'mountPlanSwitchRoutes', app);
  await safeImportMount('webauthn', () => import('./routes/webauthnRoutes.js'), 'mountWebAuthnRoutes', app);
  await safeImportMount('push', () => import('./routes/pushRoutes.js'), 'mountPushRoutes', app);
  await safeImportMount('jobs', () => import('./routes/jobsRoutes.js'), 'mountJobsRoutes', app);
  await safeImportMount('monthlyReports', () => import('./routes/monthlyReportJobRoutes.js'), 'mountMonthlyReportJobRoutes', app);
  await safeImportMount('paypal', () => import('./routes/paypalRoutes.js'), 'mountPayPalRoutes', app);
  await safeImportMount('pix', () => import('./routes/pixRoutes.js'), 'mountPixRoutes', app);
  await safeImportMount('wechat', () => import('./routes/wechatRoutes.js'), 'mountWechatRoutes', app);
  await safeImportMount('subscription', () => import('./routes/subscriptionRoutes.js'), 'mountSubscriptionRoutes', app);
  await safeImportMount('unidade', () => import('./routes/unidadeRoutes.js'), 'mountUnidadeRoutes', app);
  await safeImportMount('export', () => import('./routes/exportRoutes.js'), 'mountExportRoutes', app);
  await safeImportMount('publicPlanos', () => import('./routes/publicPlanosRoutes.js'), 'mountPublicPlanosRoutes', app);
  await safeImportMount('audit', () => import('./routes/auditRoutes.js'), 'mountAuditRoutes', app);
  await safeImportMount('n8nEmail', () => import('./routes/n8nEmailRoutes.js'), 'mountN8nEmailRoutes', app);
  await safeImportMount('n8n', () => import('./routes/n8nRoutes.js'), 'mountN8nRoutes', app);
  await safeImportMount('smtpTest', () => import('./routes/smtpTestRoutes.js'), 'mountSmtpTestRoutes', app);

  await safeMount('adminLogin', async () => {
    const { mountAdminLoginRoute } = await import('./adminLoginRoute.js');
    mountAdminLoginRoute(app, getDb, { setAuthCookie, JWT_SECRET });
  });
  await safeMount('adminPasswordReset', async () => {
    const { mountAdminPasswordResetRoutes } = await import('./adminPasswordReset.js');
    mountAdminPasswordResetRoutes(app, getDb);
  });
  await safeMount('mfa', async () => {
    const { mountMfaRoutes } = await import('./mfa.js');
    mountMfaRoutes(app, getDb, { JWT_SECRET, setAuthCookie, autenticarToken });
  });
  await safeMount('passwordReset', async () => {
    const { mountPasswordResetRoutes } = await import('./passwordResetRoutes.js');
    mountPasswordResetRoutes(app, getDb);
  });
  await safeMount('stripe', async () => {
    const { mountStripeRoutes } = await import('./stripeRoutes.js');
    mountStripeRoutes(app, getDb);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  const off = getMountResults().filter((r) => !r.ok);
  console.log(`📦 build ${BUILD.version} marker=${BUILD.marker}`);
  console.log(`📋 módulos: ${getMountResults().filter((r) => r.ok).length} ok, ${off.length} off`);
  if (off.length) {
    for (const o of off) console.warn(`   · ${o.name}: ${o.error}`);
  }

  try {
    const { stripeConfigured } = await import('./stripeBilling.js');
    const { paypalConfigured } = await import('./lib/paypal.js');
    const { mpConfigured } = await import('./lib/mercadopago.js');
    const { wechatConfigured } = await import('./lib/wechat.js');
    const { smtpConfigured } = await import('./lib/mailer.js');
    const { n8nConfigured } = await import('./lib/n8n.js');
    console.log(
      `💳 Stripe: ${stripeConfigured() ? 'ok' : 'OFF'} | Pix: ${mpConfigured() ? 'ok' : 'OFF'} | PayPal: ${paypalConfigured() ? 'ok' : 'OFF'} | WeChat: ${wechatConfigured() ? 'ok' : 'OFF'}`
    );
    console.log(`📧 SMTP: ${smtpConfigured() ? 'ok' : 'OFF'} | n8n: ${n8nConfigured() ? 'ok' : 'OFF'}`);
  } catch (e: any) {
    console.warn('status integrações:', e?.message || e);
  }

  server = app.listen(PORT, () => {
    console.log(`🚀 API Filtra.IA em http://localhost:${PORT}`);
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

main().catch((e) => {
  console.error('❌ Boot fatal (só DB/JWT devem causar isso):', e);
  process.exit(1);
});
