/**
 * Classificação conservadora dos resultados das chamadas de IA do Filtra Dot.
 * Quando há failover, a classificação considera TODAS as tentativas: um erro
 * ambíguo anterior nunca pode ser apagado por uma recusa posterior.
 */
export type DotProviderOutcome = 'not_sent' | 'ambiguous' | 'rejected';

const NOT_SENT_PATTERNS = [
  /Nenhuma IA configurada/i,
  /não configurada/i,
  /no provider/i,
];

const REJECTED_STATUSES = new Set([400, 401, 402, 403, 404, 413, 422]);
const NOT_PROCESSED_EVIDENCE = [
  /not processed/i,
  /no tokens? generated/i,
  /rejected before processing/i,
  /quota exceeded before (any )?processing/i,
];

const PROVIDER_ERROR_SOURCES: Record<string, RegExp> = {
  groq: /^Groq API error\s*\d{3}/,
  gemini: /^Gemini API error\s*\d{3}/,
};

function providerErrorSource(error: any): 'groq' | 'gemini' | null {
  const message = String(error?.message || '');
  for (const [provider, pattern] of Object.entries(PROVIDER_ERROR_SOURCES)) {
    if (pattern.test(message)) return provider as 'groq' | 'gemini';
  }
  return null;
}

function aggregateErrors(error: unknown): unknown[] | null {
  if (error instanceof AggregateError) return Array.from(error.errors || []);
  const nested = (error as any)?.errors;
  return Array.isArray(nested) ? nested : null;
}

function classifySingleProviderError(error: unknown): DotProviderOutcome {
  const message = String((error as any)?.message || error || '');
  if (NOT_SENT_PATTERNS.some((pattern) => pattern.test(message))) return 'not_sent';

  const source = providerErrorSource(error);
  const status = Number((error as any)?.status || 0);
  if (source) {
    if (status === 429) {
      return NOT_PROCESSED_EVIDENCE.some((pattern) => pattern.test(message))
        ? 'rejected'
        : 'ambiguous';
    }
    if (status >= 400 && REJECTED_STATUSES.has(status)) return 'rejected';
    if (status >= 400) return 'ambiguous';
  }
  return 'ambiguous';
}

export function classifyDotProviderError(error: unknown): DotProviderOutcome {
  const errors = aggregateErrors(error);
  if (errors) {
    if (!errors.length) return 'ambiguous';
    const outcomes = errors.map(classifySingleProviderError);
    // Qualquer tentativa ambígua significa que algum provedor pode ter
    // processado/cobrado a solicitação. Nunca liberar com base no último erro.
    if (outcomes.includes('ambiguous')) return 'ambiguous';
    if (outcomes.every((outcome) => outcome === 'not_sent')) return 'not_sent';
    if (outcomes.every((outcome) => outcome === 'rejected')) return 'rejected';
    return 'ambiguous';
  }
  return classifySingleProviderError(error);
}

export function isProviderHttpRejection(error: unknown): boolean {
  const errors = aggregateErrors(error);
  if (errors) return errors.length > 0 && errors.every((item) => providerErrorSource(item) !== null);
  return providerErrorSource(error) !== null;
}

export function isProvenNotSent(outcome: DotProviderOutcome, error?: unknown): boolean {
  if (outcome === 'not_sent') return true;
  if (outcome !== 'rejected') return false;
  if (error === undefined) return true;
  return isProviderHttpRejection(error);
}

export function describeDotProviderOutcome(outcome: DotProviderOutcome): string {
  if (outcome === 'not_sent') return 'nenhum provedor de IA configurado; nada foi enviado';
  if (outcome === 'rejected') return 'provedor recusou a solicitação antes de gerar resposta';
  return 'resultado desconhecido após envio ao provedor';
}
