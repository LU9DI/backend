# Filtra DOT — proposta: `lib/aiUsage.ts`

**Modo:** somente leitura. `lib/aiUsage.ts` **não** foi alterado. HEAD `a907a345bd38523b1b984364235686f3641a7700`.

- Tipo: **hunk**
- Diffstat: `1 file changed, 19 insertions(+), 2 deletions(-)`
- Proposta: `review/aiUsage.ledger.proposed.ts.txt`
- Diff: `review/aiUsage.ledger.proposed.diff`

## Contratos/exportações
- `ensureAiUsageSchema` adiciona `tokens_input`/`tokens_output` (ALTER idempotente)
- `recordAiUsage` grava a quebra in/out (NULL quando indisponível)

## Dependências
- nenhuma nova

## Testes associados
- `aiUsageDedup.test`
- `dotMigrationLegacy.test`

## Risco
- Sem impacto nos consumidores atuais (colunas novas opcionais).

> Relatório consolidado: `review/ledger-support-batch-proposal.md`.
