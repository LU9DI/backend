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

export function buildCorsOptions(): CorsOptions {
  const isProd = isProductionRuntime();
  const fromEnv = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const defaults = [process.env.APP_URL, process.env.FRONTEND_URL]
    .filter(Boolean)
    .map((s) => String(s).replace(/\/$/, ''));
  const allowlist = [...new Set([...fromEnv, ...defaults])];

  if (!isProd) return { origin: true, credentials: true };
  if (allowlist.length === 0) {
    console.warn('[cors] PRODUÇÃO sem CORS_ORIGINS/APP_URL/FRONTEND_URL — requests com Origin serão bloqueados.');
  }
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
