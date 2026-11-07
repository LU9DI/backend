/**
 * Classificação do resultado de uma chamada de IA (para o ledger do Dot).
 *
 * O ledger precisa distinguir três situações que antes viravam a mesma coisa
 * ("erro"):
 *
 *  - **comprovadamente não enviada** — nenhum provedor configurado, ou a falha
 *    aconteceu antes de qualquer requisição HTTP. Liberar a reserva é seguro.
 *  - **ambígua** — a requisição pode ter chegado ao provedor (timeout, conexão
 *    interrompida, corpo inválido, falha de leitura). O provedor pode ter
 *    cobrado. A reserva continua comprometendo o orçamento até reconciliação.
 *  - **recusada pelo provedor** — o provedor respondeu HTTP 4xx ESTRUTURADO
 *    ANTES de gerar conteúdo (400/401/402/403/404/413/422). É seguro liberar.
 *    408, 5xx e 429 são AMBÍGUOS por padrão (a geração pode ter começado); um
 *    429 só é "recusada" com evidência EXPLÍCITA de não processamento — ver
 *    `isProvenNotSent`.
 *
 * A decisão é conservadora por construção: na dúvida, ambígua.
 */

export type DotProviderOutcome = 'not_sent' | 'ambiguous' | 'rejected';

const NOT_SENT_PATTERNS = [
  /Nenhuma IA configurada/i,
  /não configurada/i,
  /no provider/i,
];

/**
 * HTTP que o provedor recusou ANTES de iniciar a geração: não há consumo.
 *
 * Justificativa por código (APIs do Groq e do Gemini):
 *  - 400/422: requisição malformada — rejeitada na validação, sem geração.
 *  - 401/403: credencial ausente/inválida — rejeitada na autenticação.
 *  - 402: pagamento/crédito ausente — rejeitada antes do modelo.
 *  - 404: modelo/endpoint inexistente — nada foi gerado.
 *  - 413: payload grande demais — rejeitado na entrada.
 *
 * NÃO entram aqui: 408 (timeout), 5xx e 429. Nesses casos a geração pode ter
 * começado/cobrado; a reserva deve permanecer comprometida até reconciliação.
 *
 * 408 (Request Timeout) é DELIBERADAMENTE ambíguo: o provedor pode ter
 * recebido e iniciado a geração antes do timeout. Nesse caso o consumo é
 * desconhecido e a reserva deve permanecer comprometida.
 */
const REJECTED_STATUSES = new Set([400, 401, 402, 403, 404, 413, 422]);

/**
 * Evidência EXPLÍCITA de que a solicitação não foi processada. Sem isto, um
 * 429 é AMBÍGUO: o provedor pode ter contabilizado a tentativa.
 */
const NOT_PROCESSED_EVIDENCE = [
  /not processed/i,
  /no tokens? generated/i,
  /rejected before processing/i,
  /quota exceeded before (any )?processing/i,
];

/**
 * Prefixos de erro ESTRUTURADO de cada provedor.
 *
 * A lista de códigos acima só vale quando a falha veio destes erros — os
 * únicos pontos do código que criam um erro com `status` a partir de uma
 * resposta HTTP real do provedor (`groqService.callGroq` / `callGemini`):
 *
 *     const err: any = new Error(`Groq API error ${response.status}: ...`);
 *     err.status = response.status;
 *
 * Assim, um 429 devolvido por proxy, gateway ou por qualquer camada local não
 * é confundido com uma recusa do modelo.
 */
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

export function classifyDotProviderError(error: unknown): DotProviderOutcome {
  const message = String((error as any)?.message || error || '');
  for (const pattern of NOT_SENT_PATTERNS) {
    if (pattern.test(message)) return 'not_sent';
  }

  // Só uma resposta HTTP estruturada do provedor pode virar "recusada".
  const source = providerErrorSource(error);
  const status = Number((error as any)?.status || 0);
  if (source) {
    if (status === 429) {
      // 429 só é recusa com evidência EXPLÍCITA de não processamento.
      return NOT_PROCESSED_EVIDENCE.some((pattern) => pattern.test(message))
        ? 'rejected'
        : 'ambiguous';
    }
    if (status >= 400 && REJECTED_STATUSES.has(status)) return 'rejected';
    // 408 e 5xx do provedor: a geração pode ter começado antes da falha.
    if (status >= 400) return 'ambiguous';
  }

  // Sem origem estruturada: pode ser timeout, DNS, conexão cortada, proxy ou
  // falha de parsing — o consumo é desconhecido. Texto contendo "HTTP 4xx"
  // vindo de qualquer outra camada NÃO é recusa do modelo.
  return 'ambiguous';
}

/**
 * O erro é uma recusa HTTP estruturada do provedor?
 *
 * Usa exatamente os mesmos prefixos que `groqService` monta — nada além disso
 * prova que a resposta veio do modelo.
 */
export function isProviderHttpRejection(error: unknown): boolean {
  return providerErrorSource(error) !== null;
}

/**
 * `true` apenas quando liberar a reserva é comprovadamente seguro.
 *
 * `rejected` exige DOIS sinais independentes: a origem estruturada do erro
 * ("Groq API error NNN" / "Gemini API error NNN") e o status na lista de
 * recusas. Nenhuma mensagem arbitrária de HTTP libera reserva.
 */
export function isProvenNotSent(outcome: DotProviderOutcome, error?: unknown): boolean {
  if (outcome === 'not_sent') return true;
  if (outcome !== 'rejected') return false;
  if (error === undefined) return true;
  return isProviderHttpRejection(error);
}

/** Rótulo curto e sanitizado para log/auditoria (sem corpo de resposta). */
export function describeDotProviderOutcome(outcome: DotProviderOutcome): string {
  if (outcome === 'not_sent') return 'nenhum provedor de IA configurado; nada foi enviado';
  if (outcome === 'rejected') return 'provedor recusou a solicitação antes de gerar resposta';
  return 'resultado desconhecido após envio ao provedor';
}
