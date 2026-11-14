/**
 * Filtra.IA � bootstrap da API (produção-ready)
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
import { latencyMiddleware, getHttpMetrics, getCounters } from './lib/metrics.js';
import { runWithObservability, logEvent } from './lib/observability.js';
import { mountTrialRoutes } from './routes/trialRoutes.js';
import { mountLeadRoutes } from './routes/leadRoutes.js';
import { mountLegalAcceptRoutes } from './routes/legalAcceptRoutes.js';
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
import { mountDotAdminRoutes } from './routes/dotAdminRoutes.js';
import { mountAdminOwnerRoutes } from './routes/adminOwnerRoutes.js';
import { ensureEmpresaOwnerSchema } from './lib/empresaOwnership.js';
import { ensureDotAdminSecuritySchema } from './services/dotAdminSecurity.js';
import { ensureDotAccessSchema } from './services/dotAccessControl.js';
import { ensureDotAgentSchema } from './services/dotAgent.js';
import { ensureMissionTables } from './services/dotAgentMissions.js';
import { startDotMonitorScheduler, stopDotMonitorScheduler, getDotSchedulerStatus } from './services/dotScheduler.js';
import { startMonthlyReportScheduler, getMonthlyReportSchedulerStatus, stopMonthlyReportSchedulerAndDrain } from './services/monthlyReportScheduler.js';
import { startDotAgentWorker, stopDotAgentWorkerAndDrain, getDotAgentWorkerStatus } from './services/dotAgentWorker.js';
import { assertDotLedgerSchema } from './services/dotLedger.js';
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
import { ensureRetryQueue, startRetryWorker, stopRetryWorkerAndDrain } from './lib/retryQueue.js';
import { registerAllRetryHandlers } from './lib/retryHandlers.js';
import { ensurePlanPricingSchema } from './lib/planPricing.js';
import { allowPlanSwitch } from './lib/plans.js';
import { smtpConfigured } from './lib/mailer.js';
import { n8nConfigured } from './lib/n8n.js';
import { ensureAcquisitionEngineSchema, startAcquisitionWorker, stopAcquisitionWorkerAndDrain } from './lib/acquisitionEngine.js';
import { startAcquisitionReplenisher, stopAcquisitionReplenisherAndDrain } from './lib/acquisitionReplenisher.js';
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
  version: '1.4.0',
  marker: 'reviews-unidade-v1',
  started_at: new Date().toISOString(),
};

/**
 * O Filtra Dot só é montado quando explicitamente habilitado.
 * O DOT continua desativado por padrão em produção: enquanto a validação de
 * segurança e os testes de produção não estiverem completos, as rotas do Dot
 * nem existem no processo � o que impede acesso por engano ou por variável de
 * ambiente presa a staging.
 *
 * Para habilitar (somente após validação local): FILTRA_DOT_ENABLED=1.
 * O monitor em background exige adicionalmente FILTRA_DOT_FORCE_ON=1.
 */
function dotRuntimeEnabled() { return process.env.FILTRA_DOT_ENABLED === '1'; }

const app = express();
app.set('trust proxy', 1);

app.get('/api/live', (_req, res) => {
  res.status(200).json({ ok: true, live: true, build: BUILD, time: new Date().toISOString() });
});

// Liveness is deliberately registered before parsers, CORS, metrics and
// application middleware. Render's health check must remain a tiny, DB-free
// response even while optional middleware or startup work is under pressure.
app.use(requestIdMiddleware);
/**
 * Contexto de correlação por requisição (AsyncLocalStorage): tudo que for
 * registrado daqui em diante — inclusive dentro de serviços assíncronos —
 * carrega o mesmo `request_id`, e o tenant é anexado após a autenticação.
 */
app.use((req, _res, next) => {
  const requestId = String((req as { requestId?: string }).requestId || '');
  runWithObservability({ requestId: requestId || 'unknown', route: req.path }, next);
});
app.use(securityHeaders);
app.use(cookieParser());
app.use(latencyMiddleware as any);
/** Registra falhas de servidor (5xx) com o mesmo request_id da resposta. */
app.use((req, res, next) => {
  const requestId = String((req as { requestId?: string }).requestId || '') || 'unknown';
  const route = req.path;
  res.on('finish', () => {
    if (res.statusCode < 500) return;
    runWithObservability({ requestId, route }, () =>
      logEvent('error', 'http_request_failed', { method: req.method, status: res.statusCode }),
    );
  });
  next();
});
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
    monthly_reports_scheduler: getMonthlyReportSchedulerStatus(),
    // Somente sinais booleanos: `/api/health` é público e não deve expor
    // mensagens de erro internas. O detalhe fica em `/api/metrics`.
    dot: {
      enabled: dotRuntimeEnabled(),
      ledger_ready: dotLedgerReady,
      scheduler_active: dotRuntimeEnabled() && getDotSchedulerStatus().timer_active,
      agent_worker_active: dotRuntimeEnabled() && getDotAgentWorkerStatus().timer_active,
    },
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

/**
 * Gauge read-only: reservas enviadas ao provedor que ultrapassaram a carência.
 * Usa exatamente os predicados do sweep do ledger; não altera reservas.
 */
async function getPendingSentOverGraceMetric(): Promise<number | null> {
  if (!dotLedgerReady) return null;
  const configuredGrace = Number(process.env.DOT_SENT_GRACE_MS || 10 * 60_000);
  const graceMs = Number.isFinite(configuredGrace) ? Math.max(0, configuredGrace) : 10 * 60_000;
  const now = new Date().toISOString();
  const graceCutoff = new Date(Date.now() - graceMs).toISOString();
  try {
    const row = await getDb().get(
      `SELECT COUNT(*) AS c FROM dot_budget_reservations
        WHERE status = 'pending' AND ambiguous = 0 AND sent_at IS NOT NULL
          AND expires_at <= ? AND sent_at <= ?`,
      [now, graceCutoff],
    );
    const count = Number(row?.c);
    return Number.isFinite(count) ? count : null;
  } catch {
    // Métrica indisponível não deve derrubar /api/metrics nem expor erro interno.
    return null;
  }
}

app.get('/api/metrics', async (req, res) => {
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
    counters: getCounters(),
    dot: {
      enabled: dotRuntimeEnabled(),
      ledger_ready: dotLedgerReady,
      pending_sent_over_grace: await getPendingSentOverGraceMetric(),
      scheduler: getDotSchedulerStatus(),
      agent_worker: getDotAgentWorkerStatus(),
    },
  });
});

const PORT = Number(process.env.PORT || 5000);
let server: Server | null = null;
let shuttingDown = false;
/** `true` só depois de VALIDAR o schema do ledger criado pela migração central. */
let dotLedgerReady = false;

/**
 * Componentes de background com parada SÍNCRONA (timer). O DOT NÒO entra aqui:
 * usa drains assíncronos próprios (`stopDotMonitorScheduler`/
 * `stopDotAgentWorkerAndDrain`), que aguardam a execução em voo. Registrar o
 * DOT aqui criaria parada DUPLICADA.
 */
const backgroundStops: Array<{ name: string; stop: () => unknown }> = [];

function trackBackground(name: string, stop: () => unknown): void {
  backgroundStops.push({ name, stop });
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
    console.log(`�x�� Backfill sentimento: updated=${r.updated} errors=${r.errors}`);
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
  console.log(`⏹  ${signal} � encerramento gracioso iniciado...`);
  const force = setTimeout(() => {
    console.error('Force exit após timeout de shutdown');
    process.exit(1);
  }, 45_000);
  force.unref();
  // Orçamento único para todas as drenagens: força o exit só depois de o
  // conjunto caber (evita o force disparar antes de closeDB()).
  const drainDeadline = Date.now() + 30_000;
  const perDrainCap = () => Math.max(250, Math.min(5_000, drainDeadline - Date.now()));

  try {
    // 1) Para de aceitar novas requisições HTTP (o processo segue vivo).
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      console.log('HTTP fechado.');
    }

    // 2) Timers dos subsistemas com parada SÍNCRONA. Aqui `stop` significa
    //    "parar o timer" � nada em voo é aguardado neste grupo.
    for (const entry of backgroundStops.slice().reverse()) {
      try {
        const result = entry.stop();
        console.log(`[shutdown] ${entry.name}: timer parado`, result === undefined ? '' : JSON.stringify(result));
      } catch (e: any) {
        console.warn(`[shutdown] falha ao parar ${entry.name}:`, e?.message || e);
      }
    }

    // 3) Drena o DOT: aguarda a execução em voo (scheduler e worker) dentro do
    //    teto individual. O retorno distingue drenagem concluída de timeout.
    const drain = async <T>(label: string, stop: () => Promise<T>): Promise<T | null> => {
      try {
        const result = await stop();
        console.log(`[shutdown] ${label}:`, JSON.stringify(result));
        return result;
      } catch (e: any) {
        console.warn(`[shutdown] falha ao drenar ${label}:`, e?.message || e);
        return null;
      }
    };
    const dotScheduler = await drain('DOT scheduler', () => stopDotMonitorScheduler(perDrainCap()));
    const dotWorker = await drain('DOT agent worker', () => stopDotAgentWorkerAndDrain(perDrainCap()));
    // Workers de background: param o timer e aguardam a execução em voo
    // (com teto individual) antes de fechar o pool.
    const retryWorker = await drain('retry worker', () => stopRetryWorkerAndDrain(perDrainCap()));
    const acquisitionWorker = await drain('acquisition worker', () => stopAcquisitionWorkerAndDrain(perDrainCap()));
    const replenisher = await drain('acquisition replenisher', () => stopAcquisitionReplenisherAndDrain(perDrainCap()));
    const monthlyReport = await drain('monthly report scheduler', () => stopMonthlyReportSchedulerAndDrain(perDrainCap()));

    // 4) Fecha o pool UMA única vez, após as drenagens. Se algum drain expirou,
    //    o risco de operação pendente fica explícito no log abaixo.
    await closeDB();
    console.log('Banco fechado.', {
      dot_scheduler: dotScheduler,
      dot_agent_worker: dotWorker,
      retry_worker: retryWorker,
      acquisition_worker: acquisitionWorker,
      replenisher,
      monthly_report: monthlyReport,
    });
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
    console.log(`�xa� API Filtra.IA listening on 0.0.0.0:${PORT}`);
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
    // O bootstrap atrasado do replenisher também é cancelado no encerramento:
    // sem isso ele podia nascer DEPOIS do fechamento do pool do PostgreSQL.
    const replenisherBoot = setTimeout(() => {
      try {
        startAcquisitionReplenisher();
      } catch (e: any) {
        console.warn('[acquisition-replenisher] delayed bootstrap failed:', e?.message || e);
      }
    }, 60_000);
    trackBackground('acquisition replenisher bootstrap', () => {
      clearTimeout(replenisherBoot);
    });
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
  try {
    // A tabela `dot_budget_reservations` e as colunas de token são criadas pela
    // migração central (`initDB`). Aqui só VALIDAMOS: sem segunda fonte de DDL
    // e sem DDL por requisição. Falha aqui mantém o DOT desativado (fail-closed).
    await assertDotLedgerSchema();
    dotLedgerReady = true;
  } catch (e) {
    console.warn('dot ledger schema:', e);
  }
  try {
    await ensureEmpresaOwnerSchema(getDb());
    await ensureDotAdminSecuritySchema();
  } catch (e) {
    console.warn('dot admin schema:', e);
  }

  await runSentimentBackfillOnBoot();
  await runLgpdSweepOnBoot();

  mountTrialRoutes(app);
  mountLeadRoutes(app);
  mountLegalAcceptRoutes(app);
  mountAuthRoutes(app);
  mountEmpresaRoutes(app);
  mountReviewRoutes(app);
  mountDiagnosticRoutes(app);
  mountAdminDashboardRoutes(app);
  mountAdminOwnerRoutes(app);
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
    if (!dotLedgerReady) {
      // Fail-closed: sem schema de orçamento validado, o DOT não é ativado; o
      // restante do servidor segue funcionando normalmente.
      app.get('/api/dot/status', (_req, res) => res.status(503).json({ ok: false, enabled: false, access: false, error: 'Filtra Dot indisponível: schema do orçamento não validado.' }));
      console.error('[dot] ledger schema inválido � Filtra Dot NÒO ativado (fail-closed).');
    } else {
      mountDotRoutes(app);
      mountDotAccessRoutes(app);
      mountDotAgentRoutes(app);
      mountDotAgentMissionRoutes(app);
      mountDotAdminRoutes(app);
      startDotMonitorScheduler();
      startDotAgentWorker();
      console.log('[dot] Filtra Dot habilitado: rotas + monitor + agente em background.');
    }
  } else {
    app.get('/api/dot/status', (_req, res) => res.status(403).json({ ok: false, enabled: false, access: false, error: 'Filtra Dot desativado. Defina FILTRA_DOT_ENABLED=1 para habilitar.' }));
    console.log('[dot] Filtra Dot desativado (defina FILTRA_DOT_ENABLED=1 para habilitar).');
  }

  // Agendador in-process do relatório mensal (sem cron externo e sem credenciais).
  startMonthlyReportScheduler();

  mountAdminLoginRoute(app, getDb, { setAuthCookie, JWT_SECRET });
  mountAdminPasswordResetRoutes(app, getDb);
  mountMfaRoutes(app, getDb, { JWT_SECRET, setAuthCookie, autenticarToken });
  mountPasswordResetRoutes(app, getDb);
  mountStripeRoutes(app, getDb);

  app.use(notFoundHandler);
  app.use(errorHandler);

  console.log(`�x� build ${BUILD.version} marker=${BUILD.marker}`);
  console.log(
    `�x� Stripe: ${stripeConfigured() ? 'ok' : 'OFF'} | Pix: ${mpConfigured() ? 'ok' : 'OFF'} | PayPal: ${paypalConfigured() ? 'ok' : 'OFF'} | WeChat: ${wechatConfigured() ? 'ok' : 'OFF'}`
  );
  console.log(`�x� SMTP: ${smtpConfigured() ? 'configurado' : 'OFF'}`);
  console.log(`�x n8n: ${n8nConfigured() ? 'webhook ON' : 'OFF'}`);
  console.log(`�x�� NFS-e: ${fiscalConfigured() ? 'configurado' : 'OFF'}`);
  console.log('�x Relatórios: structured-json / canais');
  if (String(process.env.NODE_ENV || '') === 'production' && String(process.env.ALLOW_PLAN_SWITCH || '').trim()) {
    console.warn('[seguranca] ALLOW_PLAN_SWITCH definido em produção é IGNORADO � troca de planos de teste permanece desativada.');
  }
  if (!wechatConfigured()) {
    console.log('�a�️  WeChat Pay OFF � defina WECHAT_APP_ID / WECHAT_MCH_ID / WECHAT_API_KEY para ligar.');
  }

  process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.once('SIGINT', () => void gracefulShutdown('SIGINT'));
}



