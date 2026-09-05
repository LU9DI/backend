/**
 * Análise de sentimento de avaliações.
 *
 * 1) Heurística rápida (sem IA) — sempre disponível
 * 2) Opcional: refino via LLM quando planTemIA + aiConfigured
 */

export type SentimentLabel = 'positivo' | 'neutro' | 'negativo';

export type SentimentResult = {
  label: SentimentLabel;
  /** -1 a +1 */
  score: number;
  source: 'heuristica' | 'ia' | 'nota';
  keywords?: string[];
};

const POS = [
  'otimo',
  'ótimo',
  'excelente',
  'maravilhoso',
  'perfeito',
  'gostei',
  'adorei',
  'recomendo',
  'bom',
  'boa',
  'rápido',
  'rapido',
  'atencioso',
  'educado',
  'limpo',
  'saboroso',
  'delicioso',
  'amigavel',
  'amigável',
  'satisfeito',
  'satisfeita',
  'melhor',
  'top',
  'incrivel',
  'incrível',
  'fantástico',
  'fantastico',
  'obrigado',
  'obrigada',
];

const NEG = [
  'ruim',
  'pessimo',
  'péssimo',
  'horrivel',
  'horrível',
  'demora',
  'demorado',
  'lento',
  'sujo',
  'frio',
  'caro',
  'absurdo',
  'nunca',
  'pior',
  'reclama',
  'reclamação',
  'reclamacao',
  'insatisfeito',
  'insatisfeita',
  'grotesco',
  'nojo',
  'nojento',
  'mal educado',
  'mal-educado',
  'fila',
  'espera',
  'atraso',
  'errado',
  'erro',
  'cobranca',
  'cobrança',
  'golpe',
  'fraude',
  'decepcionado',
  'decepcionada',
  'odio',
  'ódio',
  'raiva',
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sentimento só pela nota (fallback) */
export function sentimentFromRating(rating: number): SentimentResult {
  if (rating >= 4) return { label: 'positivo', score: 0.6 + (rating - 4) * 0.2, source: 'nota' };
  if (rating <= 2) return { label: 'negativo', score: -0.6 - (3 - rating) * 0.15, source: 'nota' };
  return { label: 'neutro', score: 0, source: 'nota' };
}

/** Heurística lexical + nota */
export function analyzeSentimentHeuristic(
  rating: number,
  comment?: string | null
): SentimentResult {
  const base = sentimentFromRating(rating);
  if (!comment || comment.trim().length < 3) return base;

  const n = normalize(comment);
  const foundPos: string[] = [];
  const foundNeg: string[] = [];

  for (const w of POS) {
    if (n.includes(normalize(w))) foundPos.push(w);
  }
  for (const w of NEG) {
    if (n.includes(normalize(w))) foundNeg.push(w);
  }

  const posW = foundPos.length;
  const negW = foundNeg.length;
  let score = base.score;

  if (posW || negW) {
    const lexical = (posW - negW) / Math.max(posW + negW, 1);
    score = Math.max(-1, Math.min(1, base.score * 0.4 + lexical * 0.6));
  }

  // intensificadores
  if (/\b(muito|super|extremamente|totalmente)\b/.test(n)) {
    score = Math.max(-1, Math.min(1, score * 1.15));
  }
  if (/\b(nao|não|nunca)\s+(recomendo|volto|gostei)/.test(n)) {
    score = Math.min(score, -0.5);
  }

  let label: SentimentLabel = 'neutro';
  if (score >= 0.2) label = 'positivo';
  else if (score <= -0.2) label = 'negativo';

  return {
    label,
    score: Math.round(score * 100) / 100,
    source: 'heuristica',
    keywords: [...foundNeg.slice(0, 4), ...foundPos.slice(0, 4)],
  };
}

export function parseSentimentFromAiJson(raw: string): SentimentResult | null {
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const label = String(parsed.sentimento || parsed.label || '').toLowerCase();
    let score = Number(parsed.score);
    if (!Number.isFinite(score)) {
      if (label.startsWith('pos')) score = 0.7;
      else if (label.startsWith('neg')) score = -0.7;
      else score = 0;
    }
    score = Math.max(-1, Math.min(1, score));
    const normLabel: SentimentLabel =
      label.startsWith('pos') ? 'positivo' : label.startsWith('neg') ? 'negativo' : 'neutro';
    return {
      label: normLabel,
      score: Math.round(score * 100) / 100,
      source: 'ia',
      keywords: Array.isArray(parsed.keywords)
        ? parsed.keywords.map(String).slice(0, 5)
        : undefined,
    };
  } catch {
    return null;
  }
}
