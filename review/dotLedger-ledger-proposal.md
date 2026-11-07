# Filtra DOT — proposta: `services/dotLedger.ts`

**Modo:** somente leitura. `services/dotLedger.ts` **não** foi alterado. HEAD `a907a345bd38523b1b984364235686f3641a7700`.

- Tipo: **novo (adaptado #141)**
- Diffstat: `905 linhas (novo)`
- Proposta: `review/dotLedger.ledger.proposed.ts.txt`
- Diff: `review/dotLedger.ledger.proposed.diff`

## Contratos/exportações
- `DotReservation`, `DotBudgetSnapshot`, `ReserveResult`, `DotBudgetAlert`
- `DOT_FEATURE`, `dotResponseTokenLimit`, `dotReservationTtlMs`
- `ensureDotLedgerSchema`, `assertDotLedgerSchema`
- `getDotBudgetSnapshot`, `reserveDotExecution`, `getDotReservation`, `markDotReservationSent`
- `finalizeDotReservation`, `releaseDotReservation`, `sweepExpiredDotReservations`
- `reconcileDotBudget`, `listOpenDotReservations`
- `sanitizeDotAlertText`, `buildDotBudgetAlert`, `emitDotBudgetAlert`, `dotFeatureLimitForPlan`

## Dependências
- `lib/db` (`getDb`, `withDbTransaction`, `dbEngine`), `lib/quota` (`getFeatureTokenLimit`, `getTokenLimit`), `lib/plans` (`normalizePlan`)

## Testes associados
- `dotLedger.test`, `dotLedger.pg.test`, `dotSentReservation.test`, `dotMigrationLegacy.test`
- `aiUsageDedup.test`, `dotChatLedger.http.test`, `dotExplainLedger.http.test`, `dotAdminBudget.http.test`

## Risco
- Concorrência de reserva/finalização; dependência de `withDbTransaction`+`pg_advisory_xact_lock`; DDL runtime vs migração central.

> Relatório consolidado: `review/ledger-support-batch-proposal.md`.
