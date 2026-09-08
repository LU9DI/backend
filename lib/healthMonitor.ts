/**
 * Health: /api/live, /api/ready, /api/health
 */
import type { Express, Request, Response } from 'express';
import { dbEngine, pingDb, dbHostLabel } from './db.js';
import { getBuildInfo } from './buildInfo.js';
import { stripeConfigured } from '../stripeBilling.js';
import { paypalConfigured } from './paypal.js';
import { mpConfigured } from './mercadopago.js';
import { n8nConfigured, n8nStatus } from './n8n.js';
import { aiConfigured, listAiProviders, getAiLoadStats } from '../groqService.js';
import { allowPlanSwitch } from './plans.js';
import { jwtRotationStatus } from './jwtKeys.js';
import { webauthnConfig } from './webauthn.js';
import { pushConfigured } from './push.js';
import { smtpConfigured } from './mailer.js';
import { getHttpMetrics } from './metrics.js';

export type CheckResult = {
  name: string;
  ok: boolean;
  latency_ms?: number;
  detail?: string;
};

let lastAlertAt = 0;
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;

async function checkDatabase(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const r = await pingDb();
    const host = dbHostLabel();
    return {
      name: 'database',
      ok: r.ok,
      latency_ms: Date.now() - t0,
      detail: r.ok ? `${r.engine}:${host}` : r.error || 'db fail',
    };
  } catch (e: any) {
    return {
      name: 'database',
      ok: false,
      latency_ms: Date.now() - t0,
      detail: String(e?.message || e).slice(0, 160),
    };
  }
}

async function checkMemory(): Promise<CheckResult> {
  const m = process.memoryUsage();
  const heapMb = Math.round(m.heapUsed / 1024 / 1024);
  const rssMb = Math.round(m.rss / 1024 / 1024);
  const limitMb = Number(process.env.HEALTH_HEAP_WARN_MB || 450);
  return {
    name: 'memory',
    ok: heapMb < limitMb,
    detail: `heap=${heapMb}MB rss=${rssMb}MB`,
  };
}

export async function maybeAlertUnhealthy(checks: CheckResult[]) {
  const url = process.env.HEALTH_ALERT_WEBHOOK_URL?.trim();
  if (!url) return;
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) return;
  if (Date.now() - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = Date.now();

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `Filtra.AI health FAIL: ${failed.map((f) => f.name).join(', ')}`,
        source: 'filtra-ai',
        time: new Date().toISOString(),
        build: getBuildInfo(),
        failed,
      }),
    });
  } catch (e: any) {
    console.warn('[health-alert]', e?.message || e);
  }
}

export async function runReadyChecks(): Promise<{ ok: boolean; checks: CheckResult[] }> {
  const checks = [await checkDatabase()];
  return { ok: checks.every((c) => c.ok), checks };
}

export async function runFullHealth(): Promise<{
  ok: boolean;
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: CheckResult[];
  deps: Record<string, unknown>;
}> {
  const checks = [await checkDatabase(), await checkMemory()];
  const dbOk = checks.find((c) => c.name === 'database')?.ok === true;
  const memOk = checks.find((c) => c.name === 'memory')?.ok === true;

  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  if (!dbOk) status = 'unhealthy';
  else if (!memOk) status = 'degraded';

  const ai = getAiLoadStats();
  const host = dbHostLabel();
  const deps = {
    db_host: host,
    supabase: /supabase/i.test(host),
    stripe: stripeConfigured(),
    paypal: paypalConfigured(),
    mercadopago: mpConfigured(),
    n8n: n8nConfigured(),
    n8n_status: n8nStatus(),
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
  };

  if (status !== 'healthy') {
    maybeAlertUnhealthy(checks).catch(() => undefined);
  }

  return { ok: status !== 'unhealthy', status, checks, deps };
}

export function mountHealthRoutes(app: Express) {
  app.get('/api/live', (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      live: true,
      build: getBuildInfo(),
      time: new Date().toISOString(),
    });
  });

  app.get('/api/ready', async (_req: Request, res: Response) => {
    const r = await runReadyChecks();
    res.status(r.ok ? 200 : 503).json({
      ok: r.ok,
      ready: r.ok,
      checks: r.checks,
      build: getBuildInfo(),
      time: new Date().toISOString(),
    });
  });

  app.get('/api/health', async (_req: Request, res: Response) => {
    try {
      const full = await runFullHealth();
      const code = full.status === 'unhealthy' ? 503 : 200;
      res.status(code).json({
        ok: full.ok,
        status: full.status,
        build: getBuildInfo(),
        db: full.checks.find((c) => c.name === 'database')?.detail || dbEngine(),
        db_ok: full.checks.find((c) => c.name === 'database')?.ok === true,
        checks: full.checks,
        ...full.deps,
        env: process.env.NODE_ENV || 'development',
        time: new Date().toISOString(),
      });
    } catch (e: any) {
      res.status(503).json({
        ok: false,
        status: 'unhealthy',
        error: String(e?.message || e).slice(0, 200),
        build: getBuildInfo(),
        time: new Date().toISOString(),
      });
    }
  });
}
