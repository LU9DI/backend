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

/**
 * Cabeçalhos do contrato de idempotência que o navegador precisa LER.
 * Sem `Access-Control-Expose-Headers` o cliente não consegue enxergar
 * `Idempotency-Replayed`/`Retry-After` em uma chamada cross-origin.
 */
const EXPOSED_HEADERS = ['Idempotency-Replayed', 'Retry-After'];

export function buildCorsOptions(): CorsOptions {
  const isProd = isProductionRuntime();
  const fromEnv = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  // Origins exatas dos dois frontends ativos no Render, do domínio público
  // e do deployment Vercel de produção observado nos logs da API.
  // Não libera curingas nem previews temporários.
  const renderFrontendOrigins = [
    'https://filtra-ai-web-cloud.onrender.com',
    'https://filtra-ai-web-runtime.onrender.com',
    'https://filtraai.com',
    'https://www.filtraai.com',
    'https://saas-reputacao-l4uo3uqrd-lu9di.vercel.app',
  ];
  const defaults = [process.env.APP_URL, process.env.FRONTEND_URL]
    .filter(Boolean)
    .map((s) => String(s).replace(/\/$/, ''));
  const allowlist = [...new Set([...fromEnv, ...defaults, ...renderFrontendOrigins])];

  if (!isProd) return { origin: true, credentials: true, exposedHeaders: EXPOSED_HEADERS };
  if (allowlist.length === 0) {
    console.warn('[cors] PRODUÇÃO sem CORS_ORIGINS/APP_URL/FRONTEND_URL — requests com Origin serão bloqueados.');
  }
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowlist.includes(origin)) return callback(null, true);
      console.warn(`[cors] origem bloqueada: ${origin}`);
      // Origem não autorizada não é erro interno: omite os cabeçalhos CORS.
      // O navegador continuará impedido de ler a resposta, sem gerar HTTP 500.
      callback(null, false);
    },
    credentials: true,
    exposedHeaders: EXPOSED_HEADERS,
  };
}
