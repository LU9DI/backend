/**
 * Monitoramento de uso e rate-limit da IA (Groq/Gemini).
 */
import type { Database } from 'sqlite';
import { getDb } from './db.js';
import { getAiLoadStats } from '../groqService.js';
import { getRateLimitHits } from './rateLimitHits.js';

export { recordRateLimitHit, isRateLimitError } from './rateLimitHits.js';

export async function getAiMonitorSnapshot(db: Database = getDb()) {
  const load = getAiLoadStats();
  const rateLimitHits = getRateLimitHits();

  const hoje = await db.get(
    `SELECT COUNT(*) as reqs, COALESCE(SUM(tokens),0) as tokens
     FROM ai_usage WHERE date(criado_em) = date('now')`
  );
  const mes = await db.get(
    `SELECT COUNT(*) as reqs, COALESCE(SUM(tokens),0) as tokens
     FROM ai_usage WHERE criado_em >= date('now', 'start of month')`
  );
  const porProviderHoje = await db.all(
    `SELECT IFNULL(provider,'desconhecido') as provider,
            COUNT(*) as reqs, COALESCE(SUM(tokens),0) as tokens
     FROM ai_usage WHERE date(criado_em) = date('now')
     GROUP BY IFNULL(provider,'desconhecido')`
  );

  const last15min = rateLimitHits.filter((h) => Date.now() - h.at < 15 * 60 * 1000);
  const last24h = rateLimitHits.filter((h) => Date.now() - h.at < 24 * 60 * 60 * 1000);

  const lastErr = load.stats.groq.lastError || '';
  const rateLimitAlert =
    last15min.length > 0 ||
    lastErr.toLowerCase().includes('429') ||
    lastErr.toLowerCase().includes('rate limit') ||
    lastErr.toLowerCase().includes('rate_limit');

  return {
    gerado_em: new Date().toISOString(),
    requests: {
      hoje: Number(hoje?.reqs || 0),
      mes: Number(mes?.reqs || 0),
      tokens_hoje: Number(hoje?.tokens || 0),
      tokens_mes: Number(mes?.tokens || 0),
      por_provider_hoje: porProviderHoje || [],
    },
    rate_limit: {
      alerta: rateLimitAlert,
      hits_15min: last15min.length,
      hits_24h: last24h.length,
      recentes: rateLimitHits.slice(0, 15).map((h) => ({
        provider: h.provider,
        detail: h.detail,
        at: new Date(h.at).toISOString(),
      })),
      mensagem: rateLimitAlert
        ? 'Groq/API retornou rate limit recentemente. Considere chave paga ou expandir limites.'
        : 'Sem estouro de rate limit recente.',
    },
    providers: load,
  };
}
