# Filtra DOT — proposta: `groqService.ts`

**Modo:** somente leitura. `groqService.ts` **não** foi alterado. HEAD `a907a345bd38523b1b984364235686f3641a7700`.

- Tipo: **hunk**
- Diffstat: `1 file changed, 63 insertions(+), 10 deletions(-)`
- Proposta: `review/groqService.ledger.proposed.ts.txt`
- Diff: `review/groqService.ledger.proposed.diff`

## Contratos/exportações
- `callAIReal` + indireção `setCallAIImpl` (**guardada a `NODE_ENV=test`**)
- `skipUsageRecord` opcional (evita contabilização dupla)
- captura `prompt_tokens`/`completion_tokens` (Groq) e `promptTokenCount`/`candidatesTokenCount` (Gemini)
- `AiCallResult.input_tokens`/`output_tokens`

## Dependências
- `lib/aiUsage` (`recordAiUsage`), `lib/db`

## Testes associados
- `aiUsageDedup.test`
- `dotChatLedger.http.test`
- `dotExplainLedger.http.test`

## Risco
- Assinatura de `callAI` preservada (só campos opcionais a mais). `setCallAIImpl` restrito a teste.

> Relatório consolidado: `review/ledger-support-batch-proposal.md`.
