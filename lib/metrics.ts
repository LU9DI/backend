/**
 * Métricas leves em memória — latência HTTP e contadores por rota.
 * Janela deslizante para percentis (p50 / p95).
 */

const MAX_SAMPLES = Math.max(50, Number(process.env.METRICS_WINDOW || 200));

type Bucket = {
  samples: number[]; // ms
  count: number;
  errors: number;
  sumMs: number;
};

const httpByRoute: Map<string, Bucket> = new Map();
const httpGlobal: Bucket = { samples: [], count: 0, errors: 0, sumMs: 0 };
const startedAt = Date.now();

function ensure(route: string): Bucket {
  let b = httpByRoute.get(route);
  if (!b) {
    b = { samples: [], count: 0, errors: 0, sumMs: 0 };
    httpByRoute.set(route, b);
  }
  return b;
}

function pushSample(b: Bucket, ms: number) {
  b.samples.push(ms);
  if (b.samples.length > MAX_SAMPLES) b.samples.shift();
  b.count += 1;
  b.sumMs += ms;
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(b: Bucket) {
  const sorted = [...b.samples].sort((a, c) => a - c);
  const last = sorted.length ? sorted[sorted.length - 1] : null;
  // last is max of window after sort - actually we want last recorded; use samples end
  const lastMs = b.samples.length ? b.samples[b.samples.length - 1] : null;
  return {
    count: b.count,
    errors: b.errors,
    window: sorted.length,
    avg_ms: b.count ? Math.round(b.sumMs / b.count) : null,
    min_ms: sorted.length ? sorted[0] : null,
    max_ms: sorted.length ? sorted[sorted.length - 1] : null,
    last_ms: lastMs,
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
  };
}

export function recordHttp(method: string, path: string, status: number, durationMs: number) {
  // normaliza path com params óbvios
  const norm = path
    .replace(/\/api\/reviews\/[^/]+/g, '/api/reviews/:ref')
    .replace(/\/api\/empresa\/[^/]+/g, '/api/empresa/:ref')
    .replace(/\/api\/painel\/[^/]+/g, '/api/painel/:ref')
    .slice(0, 120);
  const key = `${method.toUpperCase()} ${norm}`;
  const b = ensure(key);
  pushSample(b, durationMs);
  pushSample(httpGlobal, durationMs);
  if (status >= 500) {
    b.errors += 1;
    httpGlobal.errors += 1;
  }
}

export function getHttpMetrics() {
  const routes: Record<string, ReturnType<typeof summarize>> = {};
  for (const [k, b] of httpByRoute.entries()) {
    routes[k] = summarize(b);
  }
  return {
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    global: summarize(httpGlobal),
    routes,
  };
}

/** Middleware Express: mede duração de cada request. */
export function latencyMiddleware(
  req: { method: string; path: string; originalUrl?: string },
  res: { on: (ev: string, cb: () => void) => void; statusCode: number },
  next: () => void
) {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ns = Number(process.hrtime.bigint() - t0);
    const ms = Math.round(ns / 1e6);
    const path = (req as any).route?.path
      ? `${req.path}`
      : (req.originalUrl || req.path || '').split('?')[0];
    recordHttp(req.method, path, res.statusCode, ms);
  });
  next();
}
