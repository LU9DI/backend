/** Persistência de consumo de tokens por empresa. */
import type { Database } from 'sqlite';

export async function recordAiUsage(
  db: Database,
  opts: {
    empresaId?: string | null;
    tipo: string;
    tokens: number;
    provider?: string;
  }
) {
  const tokens = Math.max(0, Math.round(Number(opts.tokens) || 0));
  if (!tokens) return;
  try {
    await db.run(
      `INSERT INTO ai_usage (empresa_id, tipo, tokens, criado_em) VALUES (?, ?, ?, datetime('now'))`,
      [opts.empresaId || null, String(opts.tipo).slice(0, 40), tokens]
    );
  } catch (e: any) {
    console.warn('[ai_usage]', e?.message || e);
  }
}

/** Estimativa se a API não devolver usage (chars ~ 4 tokens). */
export function estimateTokens(system: string, user: string, output: string): number {
  const chars = (system?.length || 0) + (user?.length || 0) + (output?.length || 0);
  return Math.max(1, Math.ceil(chars / 4));
}
