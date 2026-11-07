# DSV4 — Matriz de contratos e dependências do DOT Durable Token Ledger

**HEAD auditado:** `a907a345bd38523b1b984364235686f3641a7700` · **Base de produção:** `origin/master` `a2e3f6b`
**Modo:** somente leitura (nenhum arquivo original alterado; stash intacto).

Legenda: ✅ contrato satisfeito · ⚠️ ressalva · ❌ quebra de contrato / ausente.

## 1. Quem importa o quê (runtime)

| Consumidor | Importa de | Símbolos | Contrato | Status |
|---|---|---|---|---|
| `routes/dotRoutes.ts` | `services/dotLedger.js` | `DOT_FEATURE, buildDotBudgetAlert, dotResponseTokenLimit, emitDotBudgetAlert, finalizeDotReservation, getDotBudgetSnapshot, listOpenDotReservations, markDotReservationSent, releaseDotReservation, reserveDotExecution, DotReservation` | todos exportados no `dotLedger` proposto | ✅ |
| `routes/dotRoutes.ts` | `services/dotProviderOutcome.js` | `classifyDotProviderError, describeDotProviderOutcome, isProvenNotSent` | exportados | ✅ |
| `routes/dotRoutes.ts` | `groqService.js` | `callAI` (com `skipUsageRecord`) | `callAIReal` honra `skipUsageRecord`; retorno tem `input_tokens`/`output_tokens` | ✅ |
| `routes/dotAdminRoutes.ts` | `services/dotLedger.js` | `getDotBudgetSnapshot, listOpenDotReservations, reconcileDotBudget` | exportados | ✅ |
| `routes/dotAdminRoutes.ts` | `services/dotAdminSecurity.js` | `requireDotAdminSession`, `getActiveDotAdminSession`, `verifyDotAdminPinForSession` | já no HEAD | ✅ |
| `server.ts` | `services/dotLedger.js` | `assertDotLedgerSchema` | exportado | ✅ |
| `server.ts` | `services/dotScheduler.js` | `startDotMonitorScheduler, stopDotMonitorScheduler` | proposto no scheduler | ✅ |
| `server.ts` | `services/dotAgentWorker.js` | `startDotAgentWorker, stopDotAgentWorkerAndDrain` | proposto no worker | ✅ |
| `server.ts` | `lib/monthlyReportScheduler.js` | `stopMonthlyReportScheduler` | **já no HEAD** | ✅ |
| `server.ts` | `lib/retryQueue.js` | `stopRetryWorker` | **ausente no HEAD** | ❌ (ver C2) |
| `server.ts` | `lib/acquisitionEngine.js` | `stopAcquisitionWorker` | **ausente no HEAD** | ❌ (ver C2) |
| `server.ts` | `lib/acquisitionReplenisher.js` | `stopAcquisitionReplenisher` | **ausente no HEAD** | ❌ (ver C2) |
| `dotLedger.ts` | `lib/db.js` | `getDb, withDbTransaction, dbEngine` | existem no HEAD | ✅ |
| `dotLedger.ts` | `lib/quota.js` | `getFeatureTokenLimit, getTokenLimit` | existem | ✅ |
| `dotLedger.ts` | `lib/plans.js` | `normalizePlan` (adaptado de `normalizePlanAlias`) | existe (#141) | ✅ |
| `groqService.ts` | `lib/aiUsage.js` | `recordAiUsage` (com `inputTokens`/`outputTokens`) | colunas propostas | ✅ |

## 2. Assinaturas exportadas (contrato)

| Símbolo | Assinatura | Consumido por |
|---|---|---|
| `reserveDotExecution` | `({empresaId, plan?, responseLimit?, executionRef?, feature?}) => Promise<ReserveResult>` | `dotRoutes` chat/explain |
| `markDotReservationSent` | `({empresaId, reservationId}) => Promise<{ok, reservation}>` | `dotRoutes` |
| `finalizeDotReservation` | `({empresaId, reservationId, tokens?, estimatedTokens?, inputTokens?, outputTokens?, provider?, tipo?, ambiguous?, ambiguousReason?}) => Promise<{ok, reservation, duplicate?, reason?}>` | `dotRoutes` |
| `releaseDotReservation` | `({empresaId, reservationId, reason?, provenNotSent}) => Promise<{ok, reservation, reason?}>` | `dotRoutes` |
| `getDotBudgetSnapshot` | `(empresaId, plan, opts?) => Promise<DotBudgetSnapshot>` | `dotRoutes`, `dotAdminRoutes` |
| `listOpenDotReservations` | `(empresaId) => Promise<DotReservation[]>` | `dotRoutes`, `dotAdminRoutes` |
| `reconcileDotBudget` | `({empresaId, reservationId, decision, tokens?, reason?, provider?}) => Promise<{ok, reservation, reason?}>` | `dotAdminRoutes` |
| `dotResponseTokenLimit` | `(plan?) => number` (fail-closed 0) | `dotRoutes` (chat demo) |
| `assertDotLedgerSchema` | `() => Promise<void>` | `server` |
| `stopDotMonitorScheduler` | `(ms=5000) => Promise<{stopped, in_flight}>` | `server` |
| `stopDotAgentWorkerAndDrain` | `(ms=5000) => Promise<{drained, running}>` | `server` |
| `stopRetryWorker` / `stopAcquisitionWorker` | `() => void` | `server` ❌ ausentes |
| `stopAcquisitionReplenisher` | `() => boolean` | `server` ❌ ausente |
| `stopMonthlyReportScheduler` | `() => void` | `server` ✅ |

## 3. Imports ausentes / incompatíveis

- ❌ **`server.ts` → `stopRetryWorker` / `stopAcquisitionWorker` / `stopAcquisitionReplenisher`**: não existem no HEAD e **não havia proposta** para `lib/retryQueue.ts` / `lib/acquisitionEngine.ts` / `lib/acquisitionReplenisher.ts`. **Correção criada:** `review/retryQueue.ledger.proposed.ts.txt`, `review/acquisitionEngine.ledger.proposed.ts.txt`, `review/acquisitionReplenisher.ledger.proposed.ts.txt` (+ diffs).
- ⚠️ **`dotRoutes` v1 continha `filtra.test.auth`/`routesApp`** — proibido em produção (requisito 8). **Correção criada:** `review/dotRoutes.ledger.proposed.v2.ts.txt` (sem o gancho) + `dotRoutes.ledger.proposed.v2.diff`.
- ⚠️ **`dotLedger` comentário** diz "`ensureDotLedgerSchema` em `server.ts`", mas o `server` proposto usa `assertDotLedgerSchema`. Doc desatualizado (P3).

## 4. Funções duplicadas / obsoletas

- ⚠️ **DDL duplicada:** `dotLedger.ensureDotLedgerSchema` recria a **mesma** tabela/colunas de `migrations.migrateDotBudgetLedger` (evidência: ambos com `CREATE TABLE IF NOT EXISTS dot_budget_reservations`; `tokens_input/tokens_output/sent_at` nos dois). Segunda implementação de DDL (P1).
- ⚠️ **`ready()` em `dotLedger`** (linha 228) está **morto** — não é chamado em nenhum caminho; era o único caller de `ensureDotLedgerSchema`. Remover ou documentar (P2).
- ✅ `checkDotTokenBudget`/`dotTokenReservations`/`releaseDotTokenReservation` **removidos** na proposta de `dotRoutes` (0 ocorrências).
- ✅ `runDotAgentWorkerTick` **preservado** no worker proposto.

## 5. Sequência correta de inicialização

1. `initDB()` → `runCentralMigrations` → `migrateCoreTables` → … → `migrateDotActionSchema` → **`migrateDotBudgetLedger`** (fonte única de DDL).
2. `assertDotLedgerSchema()` (validação) → `dotLedgerReady`.
3. Workers: retry, acquisition (+replenisher 60 s), producthunt, hubspot.
4. `mount*Routes`; DOT ativa só se `dotRuntimeEnabled() && dotLedgerReady`.
5. Scheduler/worker DOT iniciam **depois** das rotas (inalterado).

## 6. Observações

- `dotRoutes` → `dotLedger` → `groqService` → `aiUsage`: contrato íntegro (com `skipUsageRecord`).
- `server` → scheduler/worker → ledger: íntegro **após** as correções C1/C2.
- `pg-test-utils` é dependência de teste (não runtime).
