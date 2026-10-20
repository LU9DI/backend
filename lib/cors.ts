/**
 * CORS com lista de origens em produção.
 *
 * Env:
 *   CORS_ORIGINS=https://app.example.com,https://seudominio.com
 *   Se vazio em prod: usa APP_URL + FRONTEND_URL.
 *   Em development: reflete qualquer origin (credentials ok).
 */
import type { CorsOptions } from 'cors';

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production';
}

const CANONICAL_FRONTEND_ORIGINS = [
  'https://filtraai.com',
  'https://www.filtraai.com',
];

export function buildCorsOptions(): CorsOptions {
  const isProd = isProductionRuntime();
  const fromEnv = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const defaults = [process.env.APP_URL, process.env.FRONTEND_URL]
    .filter(Boolean)
    .map((s) => String(s).replace(/\/$/, ''));
  // Keep the production frontend reachable even when a stale CORS_ORIGINS
  // value omits the canonical domain. These are exact origins, not wildcards.
  const allowlist = [...new Set([...CANONICAL_FRONTEND_ORIGINS, ...fromEnv, ...defaults])];

  if (!isProd) return { origin: true, credentials: true };
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowlist.includes(origin)) return callback(null, true);
      console.warn(`[cors] origem bloqueada: ${origin}`);
      callback(new Error(`Origin não permitida: ${origin}`));
    },
    credentials: true,
  };
}
