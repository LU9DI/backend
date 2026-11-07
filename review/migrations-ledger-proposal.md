# Filtra DOT — proposta: `lib/migrations.ts`

**Modo:** somente leitura. `lib/migrations.ts` **não** foi alterado. HEAD `a907a345bd38523b1b984364235686f3641a7700`.

- Tipo: **hunk**
- Diffstat: `1 file changed, 70 insertions(+)`
- Proposta: `review/migrations.ledger.proposed.ts.txt`
- Diff: `review/migrations.ledger.proposed.diff`

## Contratos/exportações
- `async function migrateDotBudgetLedger(db)` (tabela `dot_budget_reservations` + 3 índices)
- `addColumnIfMissing` em `ai_usage` (`provider`, `feature`, `tokens_input`, `tokens_output`)
- `addColumnIfMissing` em `dot_budget_reservations` (`sent_at`)
- chamada `await migrateDotBudgetLedger(db)` em `runCentralMigrations`

## Dependências
- helpers do próprio arquivo (`createTableIfMissing`, `addColumnIfMissing`, `createIndexIfMissing`)

## Testes associados
- `dotMigrationLegacy.test` (banco legado)
- `dbMigrationsGuards.test`

## Risco
- Fonte única de DDL; inserido depois de `migrateDotActionSchema` (HEAD), antes de `runCentralMigrations`.

> Relatório consolidado: `review/ledger-support-batch-proposal.md`.
