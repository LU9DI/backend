/** Persistência e métricas de consumo de tokens por empresa. */
import type { Database } from 'sqlite';

export async function ensureAiUsageSchema(db: Database) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT,
      tipo TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const cols = (await db.all(`PRAGMA table_info(ai_usage)`)).map((c: any) => c.name);
  if (!cols.includes('provider')) {
    await db.exec(`ALTER TABLE ai_usage ADD COLUMN provider TEXT`);
  }
  // Namespace de consumo por capacidade (ex.: 'dot'). Sem feature, a linha
  // pertence ao orçamento de feedback/reviews e continua contando na cota geral.
  if (!cols.includes('feature')) {
    await db.exec(`ALTER TABLE ai_usage ADD COLUMN feature TEXT`);
  }
}

export async function recordAiUsage(
  db: Database,
  opts: {
    empresaId?: string | null;
    tipo: string;
    tokens: number;
    provider?: string;
    feature?: string | null;
  }
) {
  const tokens = Math.max(0, Math.round(Number(opts.tokens) || 0));
  if (!tokens) return;
  try {
    await ensureAiUsageSchema(db);
    await db.run(
      `INSERT INTO ai_usage (empresa_id, tipo, tokens, provider, feature, criado_em)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [
        opts.empresaId || null,
        String(opts.tipo).slice(0, 40),
        tokens,
        opts.provider ? String(opts.provider).slice(0, 20) : null,
        opts.feature ? String(opts.feature).toLowerCase().slice(0, 40) : null,
      ]
    );
  } catch (e: any) {
    console.warn('[ai_usage]', e?.message || e);
  }
}

export function estimateTokens(system: string, user: string, output: string): number {
  const chars = (system?.length || 0) + (user?.length || 0) + (output?.length || 0);
  return Math.max(1, Math.ceil(chars / 4));
}

/** Custo estimado USD por 1M tokens (aproximado, configurável). */
export function costUsdPer1M(provider?: string | null): number {
  const p = String(provider || '').toLowerCase();
  if (p === 'gemini') return Number(process.env.AI_COST_GEMINI_PER_1M || 0.1);
  if (p === 'groq') return Number(process.env.AI_COST_GROQ_PER_1M || 0.05);
  return Number(process.env.AI_COST_DEFAULT_PER_1M || 0.08);
}

export async function getTokenMetrics(db: Database, days = 30) {
  await ensureAiUsageSchema(db);
  const d = Math.min(90, Math.max(1, days));

  const total = await db.get(
    `SELECT COALESCE(SUM(tokens),0) as tokens, COUNT(*) as eventos
     FROM ai_usage WHERE criado_em >= datetime('now', ?)`,
    [`-${d} days`]
  );

  const porTipo = await db.all(
    `SELECT tipo, COALESCE(SUM(tokens),0) as tokens, COUNT(*) as eventos
     FROM ai_usage WHERE criado_em >= datetime('now', ?)
     GROUP BY tipo ORDER BY tokens DESC`,
    [`-${d} days`]
  );

  const porProvider = await db.all(
    `SELECT IFNULL(provider,'desconhecido') as provider,
            COALESCE(SUM(tokens),0) as tokens, COUNT(*) as eventos
     FROM ai_usage WHERE criado_em >= datetime('now', ?)
     GROUP BY IFNULL(provider,'desconhecido') ORDER BY tokens DESC`,
    [`-${d} days`]
  );

  const porDia = await db.all(
    `SELECT date(criado_em) as dia, COALESCE(SUM(tokens),0) as tokens, COUNT(*) as eventos
     FROM ai_usage WHERE criado_em >= datetime('now', ?)
     GROUP BY date(criado_em) ORDER BY dia ASC`,
    [`-${d} days`]
  );

  const topEmpresas = await db.all(
    `SELECT u.empresa_id, COALESCE(SUM(u.tokens),0) as tokens, COUNT(*) as eventos,
            e.nome_empresa, e.plan, e.cnpj
     FROM ai_usage u
     LEFT JOIN empresas e ON e.id = u.empresa_id
     WHERE u.criado_em >= datetime('now', ?) AND u.empresa_id IS NOT NULL
     GROUP BY u.empresa_id
     ORDER BY tokens DESC LIMIT 15`,
    [`-${d} days`]
  );

  let custo_estimado_usd = 0;
  for (const row of porProvider || []) {
    const t = Number(row.tokens || 0);
    custo_estimado_usd += (t / 1_000_000) * costUsdPer1M(row.provider);
  }

  return {
    janela_dias: d,
    total_tokens: Number(total?.tokens || 0),
    total_eventos: Number(total?.eventos || 0),
    custo_estimado_usd: Math.round(custo_estimado_usd * 10000) / 10000,
    por_tipo: porTipo,
    por_provider: porProvider,
    por_dia: porDia,
    top_empresas: topEmpresas,
  };
}
