/**
 * CORS com lista de origens em produção.
 * Em origem bloqueada: falha sem ecoar o domínio na mensagem ao cliente.
 */
import type { CorsOptions } from 'cors';

export function buildCorsOptions(): CorsOptions {
  const isProd = process.env.NODE_ENV === 'production';

  const fromEnv = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);

  const defaults = [process.env.APP_URL, process.env.FRONTEND_URL]
    .filter(Boolean)
    .map((s) => String(s).replace(/\/$/, ''));

  // sempre inclui filtraai.com em produção
  const hardDefaults = isProd
    ? ['https://filtraai.com', 'https://www.filtraai.com']
    : [];

  const allowlist = [...new Set([...fromEnv, ...defaults, ...hardDefaults])];

  if (!isProd || allowlist.length === 0) {
    return { origin: true, credentials: true };
  }

  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      const o = origin.replace(/\/$/, '');
      if (allowlist.includes(o)) return callback(null, true);
      // log interno só — cliente recebe 403 genérico via error handler / cors
      console.warn('[cors] origem bloqueada');
      callback(new Error('Forbidden'));
    },
    credentials: true,
  };
}
