# DSV4 — Sequência corrigida de implementação do DOT Durable Token Ledger

**HEAD:** `a907a345bd38523b1b984364235686f3641a7700` · Ordem revisada para evitar falhas de compilação e regressões.

## Etapa 0 — Pré-requisitos (sem código)

1. Decidir **R03** (fonte única de DDL): migração central é a autoridade; remover/delegar `ensureDotLedgerSchema` e remover `ready()` morto.
2. Decidir **R05** (drain de retry/acquisition): implementar `stopXAndDrain` **ou** aceitar/documentar timers.
3. Confirmar **R06** (`dotResponseTokenLimit` fail-closed) com o consumidor demo.

## Etapa 1 — Folhas (sem dependência interna)

1. `services/dotProviderOutcome.ts` (**novo**) — `review/dotProviderOutcome.ledger.proposed.ts.txt`.
2. `lib/migrations.ts` (**hunk**) — `migrateDotBudgetLedger` + chamada — `review/migrations.ledger.proposed.ts.txt`.
3. `lib/aiUsage.ts` (**hunk**) — colunas `tokens_input`/`tokens_output` — `review/aiUsage.ledger.proposed.ts.txt`.

**Gate:** `npm run build` (tsc) + `tests/dotProviderOutcome.test`, `tests/dotMigrationLegacy.test`.

## Etapa 2 — Núcleo do ledger

4. `services/dotLedger.ts` (**novo, adaptado #141**) — `review/dotLedger.ledger.proposed.ts.txt` (depende de 1–3).

**Gate:** `tests/dotLedger.test`, `tests/dotSentReservation.test`, `tests/dotMigrationLegacy.test`, `tests/aiUsageDedup.test`.

## Etapa 3 — Provedor/contabilização

5. `groqService.ts` (**hunk**) — `skipUsageRecord`, tokens in/out, `setCallAIImpl` restrito a teste — `review/groqService.ledger.proposed.ts.txt`.

**Gate:** `tests/aiUsageDedup.test`, `tests/dotChatLedger.http.test` (após Etapa 4).

## Etapa 4 — Rotas do DOT

6. `routes/dotAdminRoutes.ts` (**hunk**) — budget/reconcile (proposta do lote P0).
7. `routes/dotRoutes.ts` (**hunk, v2 sem `filtra.test.auth`**) — `review/dotRoutes.ledger.proposed.v2.ts.txt`; migrar `dotChatLedger.http.test`/`dotExplainLedger.http.test` para **JWT real**.

**Gate:** `tests/dotAdminBudget.http.test` (14/14), `dotChatLedger.http.test`, `dotExplainLedger.http.test`, `dotRouteProtection.test`, `dot-plan-identification.test`.

## Etapa 5 — Background e shutdown

8. `services/dotScheduler.ts` (**hunk**) — `review/dotScheduler.ledger.proposed.ts.txt`.
9. `services/dotAgentWorker.ts` (**hunk**) — `review/dotAgentWorker.ledger.proposed.ts.txt`.
10. **Correções C2 (obrigatórias para o `server`):**
    - `lib/retryQueue.ts` — `review/retryQueue.ledger.proposed.ts.txt`
    - `lib/acquisitionEngine.ts` — `review/acquisitionEngine.ledger.proposed.ts.txt`
    - `lib/acquisitionReplenisher.ts` — `review/acquisitionReplenisher.ledger.proposed.ts.txt`
11. `server.ts` (**hunk**) — `review/server.ledger.proposed.ts.txt` (depende de 8–10).

**Gate:** `tests/workerSchemaBootstrap.test` (#143), `dotSchedulerDrain.test`, `dotWorkerTickShare.test`, `dotShutdown.test`, `dotShutdownDrain.test`, `dotExecutionFlow.test`.

## Etapa 6 — Testes/CI/config

12. `tests/helpers/pg-test-utils.ts` — `review/pg-test-utils.ledger.proposed.ts.txt`.
13. **Correções C3:** `tests/dotExecutionAtomicity.pg.test.ts` e `tests/dotActionConcurrency.pg.test.ts` — propostas `.pg.test.proposed.ts.txt`.
14. `.github/workflows/ci.yml` — `review/ci.ledger.proposed.yml.txt`.
15. `.env.example` — `review/env.example.ledger.proposed.txt`.

**Gate:** `tests/pgTestUtilsSafety.test`; `npm run test:postgres` (PG 17, locale C, host local); CI verde.

## Etapa 7 — Validação global

16. `npm run build` · `npm test` · `npm run test:postgres` · `npm run audit`.
17. Homologação em runtime com `FILTRA_DOT_ENABLED=1` e `FILTRA_DOT_FORCE_ON` **ausente** (não executar deploy nesta etapa).

## Dependências entre artefatos

```
dotProviderOutcome ─┐
migrations ─────────┼─► dotLedger ─┬─► dotAdminRoutes ─► dotRoutes(v2) ─┐
aiUsage ────────────┘              │                                    │
groqService ───────────────────────┘                                    │
dotScheduler ─┐                                                         │
dotAgentWorker┼─► server ◄── retryQueue/acquisitionEngine/Replenisher ──┘
              │      ▲
pg-test-utils ┴──────┴─► dotExecutionAtomicity/dotActionConcurrency (guard)
```

## Proibições desta etapa

Não aplicar propostas, não usar `stash apply/pop`, não editar originais, não `git add`/commit/push/merge/deploy.
