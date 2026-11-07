# Filtra DOT — lote de suporte do ledger (propostas de revisão)

**Modo:** somente leitura. Nenhum arquivo original alterado, stash não aplicado.
**Repositório:** `C:\Users\lucas\backend-pr139-integration`
**Branch:** `reconcile/dot-production-2026-11-06`
**HEAD:** `a907a345bd38523b1b984364235686f3641a7700`
**Fontes:** `stash@{0}` (rastreado) e `stash@{0}^3` (novos).

---

## 1. Artefatos do lote

| Arquivo-alvo | Proposta | Diff | Relatório | Diffstat |
|---|---|---|---|---|
| `services/dotProviderOutcome.ts` | `dotProviderOutcome.ledger.proposed.ts.txt` | `dotProviderOutcome.ledger.proposed.diff` | `dotProviderOutcome-ledger-proposal.md` | novo (122 linhas) |
| `services/dotLedger.ts` | `dotLedger.ledger.proposed.ts.txt` | `dotLedger.ledger.proposed.diff` | `dotLedger-ledger-proposal.md` | novo (905 linhas) |
| `lib/migrations.ts` | `migrations.ledger.proposed.ts.txt` | `migrations.ledger.proposed.diff` | `migrations-ledger-proposal.md` | +70 |
| `lib/aiUsage.ts` | `aiUsage.ledger.proposed.ts.txt` | `aiUsage.ledger.proposed.diff` | `aiUsage-ledger-proposal.md` | +19 −2 |
| `groqService.ts` | `groqService.ledger.proposed.ts.txt` | `groqService.ledger.proposed.diff` | `groqService-ledger-proposal.md` | +63 −10 |
| `tests/helpers/pg-test-utils.ts` | `pg-test-utils.ledger.proposed.ts.txt` | `pg-test-utils.ledger.proposed.diff` | `pg-test-utils-ledger-proposal.md` | +39 |
| `.github/workflows/ci.yml` | `ci.ledger.proposed.yml.txt` | `ci.ledger.proposed.diff` | `ci-ledger-proposal.md` | +14 −1 |
| `.env.example` | `env.example.ledger.proposed.txt` | `env.example.ledger.proposed.diff` | `env.example-ledger-proposal.md` | +7 |

Todos os `.ts` passaram **validação de sintaxe** (`typescript.transpileModule`) — **nenhum teste foi executado**.

## 2. Matriz de dependências

```
dotProviderOutcome  (folha)
        ▲
dotLedger ──► lib/db (withDbTransaction, dbEngine) ──► adapters SQLite/PostgreSQL
        │        lib/quota (getFeatureTokenLimit, getTokenLimit)
        │        lib/plans (normalizePlan — #141)
        ├──► lib/migrations (cria dot_budget_reservations + colunas)   [fonte única de DDL]
        ├──► lib/aiUsage (colunas tokens_input/output)
        └──► groqService (skipUsageRecord + input/output_tokens)
                ▲
dotRoutes / dotAdminRoutes / server  (já propostos em review/)
```
- `dotLedger` **depende** de `dotProviderOutcome`, `lib/db`, `lib/quota`, `lib/plans`, migrações e `groqService`.
- `server.ts` (proposto) usa `assertDotLedgerSchema` → depende de `dotLedger`.
- `pg-test-utils` é dependência dos testes PG (não do runtime).

## 3. Contratos e assinaturas exportadas

**`dotProviderOutcome`** — `DotProviderOutcome`; `classifyDotProviderError(error)`; `isProviderHttpRejection(error)`; `isProvenNotSent(outcome, error?)`; `describeDotProviderOutcome(outcome)`.

**`dotLedger`** — `DOT_FEATURE`; `dotResponseTokenLimit(plan?)`; `dotReservationTtlMs()`; `ensureDotLedgerSchema()`; `assertDotLedgerSchema()`; `getDotBudgetSnapshot(empresaId, plan, opts?)`; `reserveDotExecution({empresaId, plan?, responseLimit?, executionRef?, feature?})`; `getDotReservation(empresaId, id)`; `markDotReservationSent({empresaId, reservationId})`; `finalizeDotReservation({empresaId, reservationId, tokens?, estimatedTokens?, inputTokens?, outputTokens?, provider?, tipo?, ambiguous?, ambiguousReason?})`; `releaseDotReservation({empresaId, reservationId, reason?, provenNotSent})`; `sweepExpiredDotReservations(opts?)`; `reconcileDotBudget({empresaId, reservationId, decision, tokens?, reason?, provider?})`; `listOpenDotReservations(empresaId)`; `sanitizeDotAlertText`, `buildDotBudgetAlert`, `emitDotBudgetAlert`, `dotFeatureLimitForPlan`. Tipos `DotReservation`, `DotBudgetSnapshot`, `ReserveResult`, `DotBudgetAlert`.

**`groqService`** — `callAI(system, user, maxTokens?, temperature?, opts?)` com `opts.skipUsageRecord?`; `setCallAIImpl` (**restrito a `NODE_ENV==='test'`**); `AiCallResult.input_tokens`/`output_tokens`.

**`pg-test-utils`** — `assertSafeTestDatabaseUrl(url)`; `databaseUrl()`; `runNodeScript`/`parseWorkerJson` preservados.

## 4. Análise de migrações

- **Fonte única:** `lib/migrations.ts` → `migrateDotBudgetLedger(db)`, chamada em `runCentralMigrations` (dentro do `execute`, sob `pg_advisory_lock`).
- Cria `dot_budget_reservations` + índices `idx_dot_budget_reservations_empresa`, `idx_..._exec` e o **único parcial** `ux_dot_budget_reservations_ai_usage (ai_usage_id) WHERE ai_usage_id IS NOT NULL`.
- Adiciona colunas idempotentes: `ai_usage.provider/feature/tokens_input/tokens_output` e `dot_budget_reservations.sent_at` (`addColumnIfMissing`).
- **Banco novo:** `migrateCoreTables` cria `ai_usage`; depois `migrateDotBudgetLedger` cria a tabela/colunas. **Banco legado:** `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` sem recriar; `dotMigrationLegacy.test` cobre.
- **Decisão `ensureDotLedgerSchema` × `assertDotLedgerSchema`** (evidência): a migração central já cria o schema; `ensureDotLedgerSchema` executaria a **mesma DDL** de novo (segunda fonte); `assertDotLedgerSchema` **valida** as colunas mínimas e falha se faltar. Decisão do `server.ts` proposto: **`assertDotLedgerSchema`** (sem DDL no boot/rota). `ensureDotLedgerSchema` permanece exportado para uso explícito/testes, mas **não** é chamado pelo servidor.
- **Sem DDL por requisição:** `getDotBudgetSnapshot`/`reserveDotExecution`/`finalize`/`release` chamam apenas `assertDotLedgerSchema`.

## 5. Compatibilidade SQLite × PostgreSQL

| Recurso | SQLite | PostgreSQL |
|---|---|---|
| `CREATE TABLE IF NOT EXISTS` / `ALTER ADD COLUMN` | ✅ | ✅ (adapter) |
| Índice **único parcial** `WHERE ai_usage_id IS NOT NULL` | ✅ | ✅ |
| `INSERT ... RETURNING id` | ✅ | ✅ (`lastID` do adapter) |
| `PRAGMA table_info` | ✅ nativo | ✅ traduzido p/ `information_schema` |
| `SELECT ... FOR UPDATE` | n/a (serializa por handle) | ✅ |
| Lock de orçamento | `withDbTransaction` serializa | `pg_advisory_xact_lock(hashtextextended(?,0))` |
| Migração sob lock | sequencial | `withMigrationLock(PG_MIGRATION_LOCK_KEY)` |

## 6. Riscos de concorrência

1. **Reserva concorrente:** `reserveDotExecution` roda em `withDbTransaction` + `lockDotBudget`; no PG, advisory xact lock por empresa. Duas instâncias não estouram o saldo.
2. **Finalização concorrente:** `SELECT ... FOR UPDATE` (PG) + `UPDATE ... WHERE status='pending'` condicional → no máximo 1 `ai_usage`.
3. **Dedup de `ai_usage`:** garantida pelo índice único parcial + transição `pending→settled`.
4. **Sweep × finalize:** `sweep` usa UPDATE condicional de uma instrução; reserva com `sent_at` **nunca** expira por TTL.
5. **Ambíguo:** `finalize({ambiguous:true})` mantém `pending`; `reconcile` exige `settle` (com tokens) ou `release` (`provenNotSent`).
6. **`setCallAIImpl`:** guardado a teste — não há troca de provedor em produção.

## 7. Matriz de testes

| Teste | Cobre | Fonte |
|---|---|---|
| `dotProviderOutcome.test` | 408 ambíguo; 4xx/429/5xx estruturados; conexão | stash^3 |
| `dotLedger.test` | reserva/finalize/retry/ambiguidade/expiração/reconciliação | stash^3 |
| `dotSentReservation.test` | `sent_at` × sweep; carência; idempotência | stash^3 |
| `dotLedger.pg.test` | 2 conexões; índice parcial; TIMESTAMPTZ; concorrência | stash^3 |
| `dotMigrationLegacy.test` | banco legado migra sem perda | stash^3 |
| `aiUsageDedup.test` | `skipUsageRecord` (sem dupla contagem) | stash^3 |
| `pgTestUtilsSafety.test` | guarda localhost/allowlist | stash^3 |
| `dotExecutionAtomicity.pg.test` | atomicidade/SOD (HEAD) | HEAD |
| `dotActionConcurrency.pg.test` | concorrência de ações (HEAD) | HEAD |
| `dotChatLedger.http` / `dotExplainLedger.http` / `dotAdminBudget.http` | HTTP chat/explain/admin | stash^3 |

**Colisão de fixtures (analisada):** `dotLedger.pg.test` cria banco próprio (`createTestDatabase('filtra_dot_ledger')`); `dotExecutionAtomicity.pg.test`/`dotActionConcurrency.pg.test` usam o `filtra_test` do CI com **tenant único** (`crypto.randomUUID()`) e limpam as próprias linhas. O runner usa `--test-concurrency=1` → **sem colisão**. **Lacuna P1:** `dotExecutionAtomicity.pg.test`/`dotActionConcurrency.pg.test` leem `process.env.DATABASE_URL` direto e **não** passam por `assertSafeTestDatabaseUrl`; em CI o step guard cobre, mas convém migrá-los para `databaseUrl()` (follow-up).

## 8. Decisões pendentes

1. **`assertDotLedgerSchema` × `ensureDotLedgerSchema`** no boot (§4) — escolhido `assert` (fonte única). Alternativa mais resiliente: `ensure`.
2. **`setCallAIImpl`** — restringir a teste (proposto) vs manter aberto (stash). A restrição quebra qualquer uso fora de `NODE_ENV=test`.
3. **`dotResponseTokenLimit` fail-closed** — proposta retorna 0 para plano não identificado (antes: 900). Confirmar consumidores (chat demo).
4. **Drain de retry/acquisition/replenisher** — não existe; só timer é parado (§ riscos do `server`).
5. **`DEFAULT_RESPONSE_LIMIT`** fica sem uso após o fail-closed — remover em follow-up ou manter.

## 9. Ordem recomendada de implementação

1. `services/dotProviderOutcome.ts` (folha).
2. `lib/migrations.ts` + `lib/aiUsage.ts` (schema/colunas — fonte única).
3. `services/dotLedger.ts` (depende de 1–2 + `lib/quota`/`lib/plans`).
4. `groqService.ts` (`skipUsageRecord` + tokens).
5. `routes/dotAdminRoutes.ts` → `routes/dotRoutes.ts`.
6. `services/dotScheduler.ts` → `services/dotAgentWorker.ts`.
7. `server.ts` (amarra boot/shutdown; depende de 3–6).
8. `tests/helpers/pg-test-utils.ts` + `.github/workflows/ci.yml` + `.env.example`.
9. Testes novos; `npm run build`; `npm test`; `npm run test:postgres`.

## 10. Verificação

- **Somente estática:** sintaxe OK (6 arquivos `.ts`), YAML do CI válido.
- **Não executados:** nenhum teste (arquivos não aplicados).
- Sem alteração de arquivos originais; stash intacto.
