import crypto from 'node:crypto';
import { getDb, findEmpresa } from '../lib/db.js';

/**
 * Contexto real do Dot.
 *
 * Este módulo tem três responsabilidades:
 *  1. montar o contexto textual com dados persistidos da empresa;
 *  2. produzir um snapshot estruturado + fingerprint dos dados verificados;
 *  3. decidir se a pergunta pode ser respondida sem gastar IA (factual) e
 *     guardar/reaproveitar respostas de raciocínio com os mesmos dados.
 *
 * O cache de respostas só é válido enquanto o fingerprint dos dados não muda:
 * uma nova avaliação ou alteração relevante invalida as respostas guardadas.
 */

type ReviewRow = {
  rating?: number | string | null;
  comment?: string | null;
  ai_reply?: string | null;
  ai_tags?: string | null;
  is_test?: number | string | null;
  createdAt?: string | null;
};

export type DotContextSnapshot = {
  total: number;
  average: number;
  positive: number;
  critical: number;
  pending: number;
  themes: Array<{ tag: string; count: number }>;
  last_review_at: string | null;
  generated_at: string;
};

export type DotContextDecision = {
  mode: 'cached' | 'refresh';
  dataSource: string;
  reasoningRequired: boolean;
  refreshRequired: boolean;
  reason: string;
};

export type DotContextForMessage = {
  context: string;
  decision: DotContextDecision;
  fingerprint: string;
  snapshot: DotContextSnapshot;
  cacheHit: boolean;
};

export type DotResponseCacheHit = {
  answer: string;
  cache_key: string;
  provider: string | null;
  model: string | null;
  tokens_used: number;
  created_at: string;
};

const DOT_RESPONSE_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.DOT_RESPONSE_CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000),
);

const QUESTION_STOPWORDS = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'de', 'da', 'do', 'das', 'dos', 'que', 'e',
  'em', 'no', 'na', 'nos', 'nas', 'para', 'por', 'com', 'sem', 'qual', 'quais',
  'quanto', 'quanta', 'quantos', 'quantas', 'me', 'minha', 'meu', 'minhas', 'meus',
  'eh', 'sao', 'ser', 'esta', 'estao', 'tem', 'ter', 'foi', 'era', 'sobre', 'ao',
  'aos', 'se', 'ja', 'como', 'favor', 'por favor', 'gostaria', 'saber', 'mostrar',
  'mostra', 'ver', 'me diga', 'diga',
]);

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalize(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

async function loadReviewRows(empresaId: string): Promise<ReviewRow[]> {
  const db = getDb();
  const queries = [
    'SELECT * FROM reviews WHERE empresa_id = ? ORDER BY createdAt DESC NULLS LAST LIMIT ?',
    'SELECT * FROM reviews WHERE empresa_id = ? ORDER BY "createdAt" DESC LIMIT ?',
    'SELECT * FROM reviews WHERE empresa_id = ? ORDER BY id DESC LIMIT ?',
  ];

  for (const query of queries) {
    try {
      const rows: ReviewRow[] = await db.all(query, [empresaId, 500]);
      return rows || [];
    } catch {
      // Tenta a próxima ordenação compatível com o esquema instalado.
    }
  }
  return [];
}

function buildSnapshot(rows: ReviewRow[]): DotContextSnapshot {
  const real = rows.filter((row) => num(row.is_test) !== 1);
  const total = real.length;
  const average = total
    ? Math.round((real.reduce((sum, row) => sum + num(row.rating), 0) / total) * 10) / 10
    : 0;
  const positive = real.filter((row) => num(row.rating) >= 4).length;
  const critical = real.filter((row) => num(row.rating) > 0 && num(row.rating) <= 3).length;
  const pending = real.filter((row) => !String(row.ai_reply || '').trim()).length;

  const counts: Record<string, number> = {};
  for (const review of real) {
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(String(review.ai_tags || '[]'));
    } catch {
      parsed = [];
    }
    if (Array.isArray(parsed)) {
      for (const tag of parsed) {
        const key = String(tag).trim();
        if (key) counts[key] = (counts[key] || 0) + 1;
      }
    }
  }

  const themes = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));

  const dates = real
    .map((row) => String(row.createdAt || '').trim())
    .filter(Boolean)
    .sort();

  return {
    total,
    average,
    positive,
    critical,
    pending,
    themes,
    last_review_at: dates.length ? dates[dates.length - 1] : null,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Fingerprint estável dos dados verificados. `generated_at` fica de fora de
 * propósito: o fingerprint representa os dados, não o momento da leitura.
 */
function fingerprintOf(snapshot: DotContextSnapshot): string {
  const material = JSON.stringify({
    total: snapshot.total,
    average: snapshot.average,
    positive: snapshot.positive,
    critical: snapshot.critical,
    pending: snapshot.pending,
    themes: snapshot.themes,
    last_review_at: snapshot.last_review_at,
  });
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

function questionKey(message: string): string {
  const tokens = normalize(message)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token && !QUESTION_STOPWORDS.has(token));
  const material = tokens.join(' ') || normalize(message).trim();
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

type DotQuestionIntent =
  | 'average' | 'total' | 'positive' | 'critical' | 'pending' | 'themes' | 'reasoning';

function classifyQuestion(message: string): DotQuestionIntent {
  const text = normalize(message);

  // Perguntas que exigem raciocínio novo nunca saem do cache factual.
  const reasoningHints = [
    'por que', 'porque', 'causa', 'impacto', 'comparar', 'comparacao', 'compare',
    'estrategia', 'plano', 'planejar', 'analisar', 'analise', 'explicar', 'explique',
    'tendencia', 'risco', 'previsao', 'recomendacao', 'recomende', 'decisao',
    'cenario', 'priorizar', 'melhorar', 'reduzir', 'aumentar', 'o que fazer', 'como ',
  ];
  if (reasoningHints.some((hint) => text.includes(hint))) return 'reasoning';

  if (text.includes('media') || text.includes('nota')) return 'average';
  if (text.includes('tema') || text.includes('assunto') || text.includes('reclama')) return 'themes';
  if (text.includes('pendente') || text.includes('sem resposta') || text.includes('aguardando')) return 'pending';
  if (text.includes('critica') || text.includes('negativa') || text.includes('ruim')) return 'critical';
  if (text.includes('positiva') || text.includes('elogio') || text.includes('bom')) return 'positive';
  if (text.includes('quantas') || text.includes('quantos') || text.includes('total')) return 'total';
  return 'reasoning';
}

function contextFromSnapshot(nomeEmpresa: string, plan: string, snapshot: DotContextSnapshot): string {
  return [
    'CONTEXTO REAL DA EMPRESA AUTENTICADA:',
    `- Empresa: ${nomeEmpresa}`,
    `- Plano: ${plan}`,
    `- Avaliações reais analisadas: ${snapshot.total}`,
    `- Nota média: ${snapshot.average}/5`,
    `- Positivas (4–5★): ${snapshot.positive}`,
    `- Críticas (1–3★): ${snapshot.critical}`,
    `- Avaliações aguardando resposta: ${snapshot.pending}`,
    `- Principais temas da IA: ${JSON.stringify(snapshot.themes)}`,
    `- Última avaliação registrada: ${snapshot.last_review_at || 'sem registro'}`,
    '- Não invente métricas além destas informações.',
  ].join('\n');
}

export async function loadDotRealContext(empresaId: string): Promise<string> {
  const empresa = await findEmpresa(empresaId);
  if (!empresa) throw new Error('Empresa não encontrada.');
  const snapshot = buildSnapshot(await loadReviewRows(empresaId));
  return contextFromSnapshot(
    String(empresa.nome_empresa || ''),
    String(empresa.plan || 'trial'),
    snapshot,
  );
}

export async function loadDotContextForMessage(
  empresaId: string,
  message: string,
): Promise<DotContextForMessage> {
  const empresa = await findEmpresa(empresaId);
  if (!empresa) throw new Error('Empresa não encontrada.');

  const snapshot = buildSnapshot(await loadReviewRows(empresaId));
  const fingerprint = fingerprintOf(snapshot);
  const context = contextFromSnapshot(
    String(empresa.nome_empresa || ''),
    String(empresa.plan || 'trial'),
    snapshot,
  );
  const intent = classifyQuestion(message);

  if (intent === 'reasoning') {
    return {
      context,
      decision: {
        mode: 'refresh',
        dataSource: 'database',
        reasoningRequired: true,
        refreshRequired: true,
        reason: 'A pergunta exige raciocínio novo sobre os dados verificados.',
      },
      fingerprint,
      snapshot,
      cacheHit: false,
    };
  }

  return {
    context,
    decision: {
      mode: 'cached',
      dataSource: 'database',
      reasoningRequired: false,
      refreshRequired: false,
      reason: 'Pergunta factual: pode ser respondida com os dados persistidos, sem gastar IA.',
    },
    fingerprint,
    snapshot,
    cacheHit: true,
  };
}

/**
 * Resposta factual determinística a partir do snapshot. Retorna `null` quando a
 * pergunta não é factual — nesse caso o fluxo segue para a IA.
 */
export function buildCachedDotAnswer(
  message: string,
  snapshot: DotContextSnapshot | null,
): string | null {
  if (!snapshot) return null;
  const intent = classifyQuestion(message);
  if (intent === 'reasoning') return null;

  if (snapshot.total === 0) {
    return 'Ainda não há avaliações reais registradas para esta empresa, então não é possível calcular esse número.';
  }

  switch (intent) {
    case 'average':
      return `A nota média é ${snapshot.average}/5, com base em ${snapshot.total} avaliações reais.`;
    case 'total':
      return `Esta empresa tem ${snapshot.total} avaliações reais analisadas.`;
    case 'positive':
      return `${snapshot.positive} de ${snapshot.total} avaliações são positivas (4–5★).`;
    case 'critical':
      return `${snapshot.critical} de ${snapshot.total} avaliações são críticas (1–3★).`;
    case 'pending':
      return `${snapshot.pending} de ${snapshot.total} avaliações aguardam resposta.`;
    case 'themes':
      if (!snapshot.themes.length) {
        return 'Ainda não há temas identificados pela IA nas avaliações desta empresa.';
      }
      return `Principais temas identificados nas avaliações: ${snapshot.themes
        .slice(0, 5)
        .map((theme) => `${theme.tag} (${theme.count})`)
        .join(', ')}.`;
    default:
      return null;
  }
}

async function ensureResponseCacheSchema() {
  const db = getDb();
  await db.exec(`CREATE TABLE IF NOT EXISTS dot_response_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id TEXT NOT NULL,
    question_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    answer TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_dot_response_cache ON dot_response_cache(empresa_id, question_key, fingerprint)',
  );
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_dot_response_cache_empresa ON dot_response_cache(empresa_id, created_at)',
  );
}

export async function getDotResponseCache(
  empresaId: string,
  message: string,
  fingerprint: string,
): Promise<DotResponseCacheHit | null> {
  if (!empresaId || !fingerprint) return null;
  await ensureResponseCacheSchema();
  const cutoff = new Date(Date.now() - DOT_RESPONSE_CACHE_TTL_MS).toISOString();
  const row = await getDb().get(
    `SELECT answer, provider, model, tokens_used, created_at FROM dot_response_cache
      WHERE empresa_id = ? AND question_key = ? AND fingerprint = ? AND created_at >= ?
      LIMIT 1`,
    [empresaId, questionKey(message), fingerprint, cutoff],
  );
  if (!row) return null;
  return {
    answer: String(row.answer),
    cache_key: `${questionKey(message)}:${fingerprint}`,
    provider: row.provider ? String(row.provider) : null,
    model: row.model ? String(row.model) : null,
    tokens_used: num(row.tokens_used),
    created_at: String(row.created_at),
  };
}

export async function putDotResponseCache(
  empresaId: string,
  message: string,
  fingerprint: string,
  answer: string,
  meta: { tokens_used: number; provider: string; model: string },
): Promise<void> {
  const text = String(answer || '').trim();
  if (!empresaId || !fingerprint || !text) return;
  await ensureResponseCacheSchema();
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO dot_response_cache
      (empresa_id, question_key, fingerprint, answer, provider, model, tokens_used, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(empresa_id, question_key, fingerprint)
      DO UPDATE SET answer = excluded.answer, provider = excluded.provider,
        model = excluded.model, tokens_used = excluded.tokens_used, updated_at = excluded.updated_at`,
    [
      empresaId,
      questionKey(message),
      fingerprint,
      text.slice(0, 20_000),
      meta.provider ? String(meta.provider).slice(0, 20) : null,
      meta.model ? String(meta.model).slice(0, 80) : null,
      Math.max(0, Math.round(num(meta.tokens_used))),
      now,
      now,
    ],
  );
}
