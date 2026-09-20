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
import { mountAdminFollowupRoutes, ensureFollowupSchema } from './routes/adminFollowupRoutes.js';
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
import { mountWechatRoutes } from './routes/wechatRoutes.js';
import { mountSubscriptionRoutes } from './routes/subscriptionRoutes.js';
import { mountUnidadeRoutes } from './routes/unidadeRoutes.js';
import { mountExportRoutes } from './routes/exportRoutes.js';
import { mountPublicPlanosRoutes } from './routes/publicPlanosRoutes.js';
import { mountAuditRoutes } from './routes/auditRoutes.js';
import { mountSmtpTestRoutes } from './routes/smtpTestRoutes.js';
import { mountN8nRoutes } from './routes/n8nRoutes.js';
import { mountPasswordResetRoutes } from './passwordResetRoutes.js';
import { mountAdminLoginRoute } from './adminLoginRoute.js';
import { mountAdminPasswordResetRoutes } from './adminPasswordReset.js';
import { mountMfaRoutes } from './mfa.js';
import { mountStripeRoutes } from './stripeRoutes.js';
import { mountFiscalRoutes } from './routes/fiscalRoutes.js';
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
import { n8nConfigured, queueN8nEvent, sendN8nWebhook } from './lib/n8n.js';
import { ensureFiscalSchema, fiscalConfigured } from './lib/fiscal.js';
import { ensureReportPdfSchema } from './lib/reportPdfStore.js';
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

const BUILD = {
  version: '1.2.0',
  marker: 'puppeteer-pdf-v1',
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
    pdf_engine: 'puppeteer',
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
    http: getHttpMetrics(),
    ai: getAiLoadStats(),
  });
});

const PORT = Number(process.env.PORT || 5000);
let server: Server | null = null;
let shuttingDown = false;


async function runProductionE2eN8nTestOnBoot() {
  if (process.env.E2E_N8N_TEST !== '1') return;
  try {
    const db = getDb();
    await db.exec(`CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      nome_empresa TEXT,
      email TEXT,
      telefone TEXT,
      fonte TEXT,
      maps_url TEXT,
      raw_json TEXT,
      criado_em TIMESTAMPTZ NOT NULL
    )`);
    try { await db.exec('ALTER TABLE leads ADD COLUMN score INTEGER'); } catch {}
    try { await db.exec('ALTER TABLE leads ADD COLUMN qualification TEXT'); } catch {}
    try { await db.exec('ALTER TABLE leads ADD COLUMN ai_reason TEXT'); } catch {}
    const email = 'e2e-n8n-test@filtraai.internal';
    let lead = await db.get('SELECT id FROM leads WHERE lower(email)=lower(?) AND fonte=? LIMIT 1', [email, 'e2e']);
    const leadId = String(lead?.id || crypto.randomUUID());
    if (!lead?.id) {
      await db.run(`INSERT INTO leads (id,nome_empresa,email,telefone,fonte,maps_url,raw_json,criado_em)
        VALUES (?, ?, ?, ?, 'e2e', ?, ?, ?)`, [leadId, 'Filtra.AI E2E Test', email, '', '', JSON.stringify({ test: true }), new Date().toISOString()]);
    }
    await queueN8nEvent('lead.followup.requested', {
      lead_id: leadId,
      nome_empresa: 'Filtra.AI E2E Test',
      email,
      telefone: '',
      fonte: 'e2e',
      score: 90,
      qualification: 'qualified',
      reason: 'Production E2E validation',
      action: 'create_crm_followup',
    }, { dedupeKey: 'e2e:n8n:lead.followup.requested' });
    console.log(`🧪 E2E n8n queued: lead.followup.requested lead_id=${leadId}`);
    const delivered = await sendN8nWebhook('lead.followup.requested', {
      lead_id: leadId, nome_empresa: 'Filtra.AI E2E Test', email, telefone: '', fonte: 'e2e',
      score: 90, qualification: 'qualified', reason: 'Production E2E validation', action: 'create_crm_followup',
    });
    console.log(`🧪 E2E n8n direct delivery: ${delivered ? 'OK' : 'FAIL'}`);
  } catch (e: any) {
    console.error('🧪 E2E n8n test failed:', e?.message || e);
  }
}
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
    await ensureFiscalSchema(getDb());
  } catch (e) {
    console.warn('ensureFiscalSchema:', e);
  }
  try {
    await ensureReportPdfSchema(getDb());
  } catch (e) {
    console.warn('ensureReportPdfSchema:', e);
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
  await runProductionE2eN8nTestOnBoot();

  mountTrialRoutes(app);
  mountAuthRoutes(app);
  mountEmpresaRoutes(app);
  mountReviewRoutes(app);
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
  mountFiscalRoutes(app);

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
  console.log('📄 PDF: puppeteer');
  if (!wechatConfigured()) {
    console.log('⚠️  WeChat Pay OFF — defina WECHAT_APP_ID / WECHAT_MCH_ID / WECHAT_API_KEY para ligar.');
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
  console.error(e);
  process.exit(1);
});
