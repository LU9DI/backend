/**
 * CORS com lista de origens em produção.
 *
 * Env:
 *   CORS_ORIGINS=https://app.vercel.app,https://seudominio.com
 *   (vírgula-separado). Se vazio em prod, usa APP_URL + FRONTEND_URL.
 *   Em development: reflete qualquer origin (credentials ok).
 */
import type { CorsOptions } from 'cors';

export function buildCorsOptions(): CorsOptions {
  const isProd = process.env.NODE_ENV === 'production';

  const fromEnv = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const defaults = [process.env.APP_URL, process.env.FRONTEND_URL]
    .filter(Boolean)
    .map((s) => String(s).replace(/\/$/, ''));

  const allowlist = [...new Set([...fromEnv, ...defaults])];

  if (!isProd) {
    return { origin: true, credentials: true };
  }

  // Falhar fechado em produção: uma API com cookies não pode refletir
  // qualquer origem quando a lista de domínios não foi configurada.
  if (allowlist.length === 0) {
    console.error('[cors] CORS_ORIGINS, APP_URL ou FRONTEND_URL é obrigatório em produção.');
    return { origin: false, credentials: true };
  }

  return {
    origin(origin, callback) {
      // requests sem Origin (curl, healthchecks, webhooks server-to-server)
      if (!origin) return callback(null, true);
      if (allowlist.includes(origin)) return callback(null, true);
      console.warn(`[cors] origem bloqueada: ${origin}`);
      callback(new Error(`Origin não permitida: ${origin}`));
    },
    credentials: true,
  };
}
