# Filtra DOT — proposta: `services/dotProviderOutcome.ts`

**Modo:** somente leitura. `services/dotProviderOutcome.ts` **não** foi alterado. HEAD `a907a345bd38523b1b984364235686f3641a7700`.

- Tipo: **novo**
- Diffstat: `122 linhas (novo)`
- Proposta: `review/dotProviderOutcome.ledger.proposed.ts.txt`
- Diff: `review/dotProviderOutcome.ledger.proposed.diff`

## Contratos/exportações
- `DotProviderOutcome = 'not_sent' | 'ambiguous' | 'rejected'`
- `classifyDotProviderError(error)`
- `isProviderHttpRejection(error)`
- `isProvenNotSent(outcome, error?)`
- `describeDotProviderOutcome(outcome)`

## Dependências
- nenhuma (folha)

## Testes associados
- `tests/dotProviderOutcome.test.ts` (408 ambíguo; 429/4xx/5xx estruturados; falha de conexão)

## Risco
- Classificação errada poderia liberar reserva de uma chamada já enviada (custo). Conservador por construção.

> Relatório consolidado: `review/ledger-support-batch-proposal.md`.
