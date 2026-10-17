/**
 * Filtra.IA — bootstrap da API (produção-ready)
 */
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import 'dotenv/config';
import type { Server } from 'http';

import { assertEnvOrExit, isProductionRuntime } from './lib/env.js';
import { initDB, getDb, dbEngine, pingDb, closeDB } from './lib/db.js';
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
import { mountDiagnosticRoutes } from './routes/diagnosticRoutes.js';
import { mountAdminDashboardRoutes } from './routes/adminDashboardRoutes.js';
import { mountAdminFollowupRoutes, ensureFollowupSchema } from './routes/adminFollowupRoutes.js';
import { mountAdminTecnicoRoutes } from './routes/adminTecnicoRoutes.js';
import { mountAdminNegocioRoutes } from './routes/adminNegocioRoutes.js';
import { mountTokenMetricsRoutes } from './routes/tokenMetricsRoutes.js';
import { mountRelatorioRoutes } from './routes/relatorioRoutes.js';
import { mountPlanSwitchRoutes } from './routes/planSwitchRoutes.js';
import { mountWebAuthnRoutes } from './routes/webauthnRoutes.js';
import { mountPushRoutes } from './routes/pushRoutes.js';
import { mountJobsRoutes } from './routes/jobsRoutes.js';
import { mountMonthlyReportJobsRoutes } from './routes/monthlyReportJobsRoutes.js';
import { mountPayPalRoutes } from './routes/paypalRoutes.js';
import { mountPixRoutes } from './routes/pixRoutes.js';
import { mountWechatRoutes } from './routes/wechatRoutes.js';
import { mountSubscriptionRoutes } from './routes/subscriptionRoutes.js';
import { mountUnidadeRoutes } from './routes/unidadeRoutes.js';
import { mountExportRoutes } from './routes/exportRoutes.js';
import { mountPublicPlanosRoutes } from './routes/publicPlanosRoutes.js';
import { mountAuditRoutes } from './routes/auditRoutes.js';
import { mountSmtpTestRoutes } from './routes/smtpTestRoutes.js';
import { mountN8nRoutes } from './routes/n8nRoutes.js';
import { mountAcquisitionRoutes, ensureAcquisitionSchema } from './routes/acquisitionRoutes.js';
import { mountTelegramRoutes } from './routes/telegramRoutes.js';
import { mountPasswordResetRoutes } from './passwordResetRoutes.js';
import { mountAdminLoginRoute } from './adminLoginRoute.js';
import { mountAdminPasswordResetRoutes } from './adminPasswordReset.js';
import { mountMfaRoutes } from './mfa.js';
import { mountStripeRoutes } from './stripeRoutes.js';
import { mountFiscalRoutes } from './routes/fiscalRoutes.js';
import { mountDotRoutes } from './routes/dotRoutes.js';
import { mountDotAccessRoutes } from './routes/dotAccessRoutes.js';
import { mountDotAgentRoutes } from './routes/dotAgentRoutes.js';
import { mountDotAgentMissionRoutes } from './routes/dotAgentMissionRoutes.js';
import { ensureDotAccessSchema } from './services/dotAccessControl.js';
import { ensureDotAgentSchema } from './services/dotAgent.js';
import { ensureMissionTables } from './services/dotAgentMissions.js';
import { startDotMonitorScheduler } from './services/dotScheduler.js';
import { startDotAgentWorker } from './services/dotAgentWorker.js';
import { mcpApp } from './filtraMcp.js';
import { stripeConfigured, refreshPlanPricesFromDb } from './stripeBilling.js';
import { paypalConfigured } from './lib/paypal.js';
import { mpConfigured } from './lib/mercadopago.js';
import { wechatConfigured } from './lib/wechat.js';
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
import { n8nConfigured } from './lib/n8n.js';
import { ensureAcquisitionEngineSchema, startAcquisitionWorker } from './lib/acquisitionEngine.js';
import { startAcquisitionReplenisher } from './lib/acquisitionReplenisher.js';
import { startProductHuntAcquisition } from './lib/acquisitionProductHunt.js';
import { startHubSpotAcquisitionSync } from './lib/hubspotAcquisitionSync.js';
import { ensureFiscalSchema, fiscalConfigured } from './lib/fiscal.js';
import {
  anonymizeOldClientWhatsapp,
  ensureReviewTreatmentColumns,
} from './lib/lgpd.js';
import {
  backfillSentiment,
  countMissingSentiment,
} from './services/sentimentBackfill.js';

const BUILD = {
  version: '1.3.0',
  marker: 'professional-report-v2',
  started_at: new Date().toISOString(),
};

/**
 * O Filtra Dot só é montado quando explicitamente habilitado.
 * O DOT continua desativado por padrão em produção: enquanto a validação de
 * segurança e os testes de produção não estiverem completos, as rotas do Dot
 * nem existem no processo — o que impede acesso por engano ou por variável de
 * ambiente presa a staging.
 *
 * Para habilitar (somente após validação local): FILTRA_DOT_ENABLED=1.
 * O monitor em background exige adicionalmente FILTRA_DOT_FORCE_ON=1.
 */
function dotRuntimeEnabled() { return process.env.FILTRA_DOT_ENABLED === '1'; }

const app = express();
app.set('trust proxy', 1);
app.use(requestIdMiddleware);
app.use(securityHeaders);
app.use(cookieParser());
app.use(latencyMiddleware as any);
app.use((req, res, next) => {
  // Stripe and Resend need the exact raw payload for signature verification.
  if (req.originalUrl?.startsWith('/api/webhook/stripe') || req.originalUrl?.startsWith('/api/n8n/acquisition/email-events') || req.originalUrl?.startsWith('/mcp')) return next();
  return express.json({ limit: '20kb' })(req, res, next);
});
app.use('/api/n8n/acquisition/email-events', express.raw({ type: 'application/json', limit: '100kb' }));
app.use(cors(buildCorsOptions()));

// Keep MCP host-header validation scoped to the MCP endpoint.
// createMcpExpressApp validates the Host header for every request that
// reaches the sub-app. Mounting it globally would reject ordinary API
// requests such as /api/dot/status when the local Host is 127.0.0.1.
app.use((req, res, next) => {
  if (req.path === '/mcp' || req.path.startsWith('/mcp/')) {
    return mcpApp(req, res, next);
  }
  return next();
});

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
    build: BUILD,
    stripe: stripeConfigured(),
    paypal: paypalConfigured(),
    pix: mpConfigured(),
    wechat: wechatConfigured(),
    ai: aiConfigured(),
    ai_providers: listAiProviders(),
    plan_switch: allowPlanSwitch(),
    jwt: jwtRotationStatus(),
    webauthn: webauthnConfig(),
    push: pushConfigured(),
    smtp: smtpConfigured(),
    n8n: n8nConfigured(),
    fiscal: fiscalConfigured(),
    report_engine: 'structured-json',
    ai_latency: {
      groq: ai.stats.groq.latency,
      gemini: ai.stats.gemini.latency,
    },
    http_latency: getHttpMetrics().global,
    env: process.env.NODE_ENV || 'unset',
    time: new Date().toISOString(),
  };

  res.status(dbPing.ok ? 200 : 503).json(body);
});

app.get('/api/metrics', (req, res) => {
  if (isProductionRuntime()) {
    const secret = (process.env.METRICS_TOKEN || process.env.JOBS_SECRET || '').trim();
    const got = String(req.headers['x-metrics-token'] || req.headers['x-jobs-secret'] || '');
    if (!secret || got !== secret) {
      return res.status(401).json({ error: 'Não autorizado.' });
    }
  }
  res.json({
    time: new Date().toISOString(),
    build: BUILD,
    http: getHttpMetrics(),
    ai: getAiLoadStats(),
  });
});

const PORT = Number(process.env.PORT || 5000);
let server: Server | null = null;
let shuttingDown = false;



async function runSentimentBackfillOnBoot() {
  if (process.env.BACKFILL_SENTIMENT !== '1') return;
  try {
    const db = getDb();
    const missing = await countMissingSentiment(db);
    if (missing === 0) return;
    const limit = Math.max(1, Number(process.env.BACKFILL_SENTIMENT_LIMIT || 500));
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
  if (process.env.LGPD_SWEEP !== '1') return;
  try {
    const db = getDb();
    await ensureReviewTreatmentColumns(db);
    await anonymizeOldClientWhatsapp(db, { limit: 1000 });
  } catch (e: any) {
    console.warn('LGPD sweep:', e?.message || e);
  }
}

async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`⏹  ${signal} — encerramento gracioso iniciado...`);
  const force = setTimeout(() => {
    console.error('Force exit após timeout de shutdown');
    process.exit(1);
  }, 25_000);
  force.unref();

  try {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      console.log('HTTP fechado.');
    }
    await closeDB();
    console.log('Banco fechado.');
    clearTimeout(force);
    process.exit(0);
  } catch (e: any) {
    console.error('Erro no shutdown:', e?.message || e);
    clearTimeout(force);
    process.exit(1);
  }
}

export async function startServer() {
  assertEnvOrExit();
  const JWT_SECRET = requireJwtSecret();

  // Bind HTTP immediately so platform health checks can reach liveness while
  // database/schema/worker initialization continues in the same instance.
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API Filtra.IA listening on 0.0.0.0:${PORT}`);
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  if (process.env.RUN_SUPABASE_MIGRATION === '1') {
    const { main: runMigration } = await import('./scripts/migrate-render-to-supabase.js');
    await runMigration();
  }
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
    await ensureFiscalSchema(getDb());
  } catch (e) {
    console.warn('ensureFiscalSchema:', e);
  }
  try {
    await ensurePlanPricingSchema(getDb());
    await refreshPlanPricesFromDb(getDb());
  } catch (e) {
    console.warn('plan pricing:', e);
  }
  try {
    await ensureFollowupSchema(getDb());
  } catch (e) {
    console.warn('ensureFollowupSchema:', e);
  }
  try {
    await ensureAcquisitionSchema(getDb());
  } catch (e) {
    console.warn('ensureAcquisitionSchema:', e);
  }
  try {
    await ensureRetryQueue(getDb());
    registerAllRetryHandlers();
    startRetryWorker();
  } catch (e) {
    console.warn('retry queue:', e);
  }
  try {
    await ensureAcquisitionEngineSchema(getDb());
    startAcquisitionWorker();
    setTimeout(() => {
      try {
        startAcquisitionReplenisher();
      } catch (e: any) {
        console.warn('[acquisition-replenisher] delayed bootstrap failed:', e?.message || e);
      }
    }, 60_000);
    await startProductHuntAcquisition();
    await startHubSpotAcquisitionSync();
  } catch (e) {
    console.warn('acquisition engine:', e);
  }
  try {
    await ensureReviewTreatmentColumns(getDb());
  } catch (e) {
    console.warn('treatment columns:', e);
  }
  try {
    await ensureDotAccessSchema();
    await ensureDotAgentSchema();
    await ensureMissionTables();
  } catch (e) {
    console.warn('dot schema:', e);
  }

  await runSentimentBackfillOnBoot();
  await runLgpdSweepOnBoot();

  mountTrialRoutes(app);
  mountAuthRoutes(app);
  mountEmpresaRoutes(app);
  mountReviewRoutes(app);
  mountDiagnosticRoutes(app);
  mountAdminDashboardRoutes(app);
  mountAdminFollowupRoutes(app);
  mountAdminTecnicoRoutes(app);
  mountAdminNegocioRoutes(app);
  mountTokenMetricsRoutes(app);
  mountRelatorioRoutes(app);
  mountPlanSwitchRoutes(app);
  mountWebAuthnRoutes(app);
  mountPushRoutes(app);
  mountJobsRoutes(app);
  mountMonthlyReportJobsRoutes(app);
  mountPayPalRoutes(app);
  mountPixRoutes(app);
  mountWechatRoutes(app);
  mountSubscriptionRoutes(app);
  mountUnidadeRoutes(app);
  mountExportRoutes(app);
  mountPublicPlanosRoutes(app);
  mountAuditRoutes(app);
  mountSmtpTestRoutes(app);
  mountN8nRoutes(app);
  mountAcquisitionRoutes(app);
  mountTelegramRoutes(app);
  mountFiscalRoutes(app);
  if (dotRuntimeEnabled()) {
    mountDotRoutes(app);
    mountDotAccessRoutes(app);
    mountDotAgentRoutes(app);
    mountDotAgentMissionRoutes(app);
    startDotMonitorScheduler();
    startDotAgentWorker();
    console.log('[dot] Filtra Dot habilitado: rotas + monitor + agente em background.');
  } else {
    app.get('/api/dot/status', (_req, res) => res.status(403).json({ ok: false, enabled: false, access: false, error: 'Filtra Dot desativado. Defina FILTRA_DOT_ENABLED=1 para habilitar.' }));
    console.log('[dot] Filtra Dot desativado (defina FILTRA_DOT_ENABLED=1 para habilitar).');
  }

  mountAdminLoginRoute(app, getDb, { setAuthCookie, JWT_SECRET });
  mountAdminPasswordResetRoutes(app, getDb);
  mountMfaRoutes(app, getDb, { JWT_SECRET, setAuthCookie, autenticarToken });
  mountPasswordResetRoutes(app, getDb);
  mountStripeRoutes(app, getDb);

  app.use(notFoundHandler);
  app.use(errorHandler);

  console.log(`📦 build ${BUILD.version} marker=${BUILD.marker}`);
  console.log(
    `💳 Stripe: ${stripeConfigured() ? 'ok' : 'OFF'} | Pix: ${mpConfigured() ? 'ok' : 'OFF'} | PayPal: ${paypalConfigured() ? 'ok' : 'OFF'} | WeChat: ${wechatConfigured() ? 'ok' : 'OFF'}`
  );
  console.log(`📧 SMTP: ${smtpConfigured() ? 'configurado' : 'OFF'}`);
  console.log(`🔗 n8n: ${n8nConfigured() ? 'webhook ON' : 'OFF'}`);
  console.log(`🧾 NFS-e: ${fiscalConfigured() ? 'configurado' : 'OFF'}`);
  console.log('📄 Relatórios: structured-json / canais');
  if (!wechatConfigured()) {
    console.log('⚠️  WeChat Pay OFF — defina WECHAT_APP_ID / WECHAT_MCH_ID / WECHAT_API_KEY para ligar.');
  }

  process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.once('SIGINT', () => void gracefulShutdown('SIGINT'));
}


