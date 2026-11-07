# DSV4 — Revisão cruzada final do DOT Durable Token Ledger

**Escopo:** revisão estática integrada de todas as propostas do Durable Token Ledger (lote principal + suporte + correções) **antes da implementação**.
**Repositório:** `C:\Users\lucas\backend-pr139-integration` · **Branch:** `reconcile/dot-production-2026-11-06`
**HEAD auditado:** `a907a345bd38523b1b984364235686f3641a7700` · **Base de produção:** `origin/master` `a2e3f6b`
**Modo:** somente leitura. Nenhum arquivo original alterado; stash intacto; nenhum commit/push/merge/deploy.
**Natureza:** **nenhum teste foi executado** — apenas inspeção estática e validação de sintaxe.

## 1. Arquivos analisados

**Lote principal (P0):** `dotRoutes`, `dotAgentWorker`, `dotScheduler`, `server` (propostas em `review/`).
**Lote de suporte:** `dotProviderOutcome`, `dotLedger`, `migrations`, `aiUsage`, `groqService`, `pg-test-utils`, `ci`, `env.example`.
**Referências:** HEAD (`a907a34`), `origin/master` (`a2e3f6b`), testes existentes, `review/ledger-support-batch-proposal.md` e os relatórios individuais.
**Correções novas desta revisão:** `dotRoutes.ledger.proposed.v2` (sem `filtra.test.auth`), `retryQueue`/`acquisitionEngine`/`acquisitionReplenisher` (stop*), `dotExecutionAtomicity.pg.test`/`dotActionConcurrency.pg.test` (guarda PG).

## 2. Incompatibilidades encontradas (com evidência)

| # | Sev | Incompatibilidade | Evidência | Correção |
|---|---|---|---|---|
| I1 | **P0** | `server` importa `stopRetryWorker`/`stopAcquisitionWorker`/`stopAcquisitionReplenisher` que **não existem no HEAD** e não tinham proposta | `server.ledger.proposed.ts.txt:81,87,88`; `grep` no HEAD → ausente | propostas C2 criadas |
| I2 | **P0** | `dotRoutes` v1 continha o gancho `filtra.test.auth` | `dotRoutes.ledger.proposed.ts.txt:189,196` | `dotRoutes` **v2** sem o gancho |
| I3 | **P1** | DDL do ledger duplicada (`dotLedger.ensureDotLedgerSchema` × `migrations.migrateDotBudgetLedger`) | ambos com `CREATE TABLE IF NOT EXISTS dot_budget_reservations` | migração central = fonte única; remover/delegar `ensure` |
| I4 | **P1** | Testes PG leem `process.env.DATABASE_URL` direto (bypass do guard local) | `dotExecutionAtomicity.pg.test.ts:23`; `dotActionConcurrency.pg.test.ts:16,17,21,76` | propostas C3 com `databaseUrl()` |
| I5 | **P1** | retry/acquisition/replenisher/monthly report **sem drain** | `server` proposto só para timers | implementar `stopXAndDrain` ou documentar |
| I6 | **P2** | `ready()` morto no `dotLedger` (único caller de `ensureDotLedgerSchema`) | `dotLedger` linha 228; 0 chamadas | remover |
| I7 | **P3** | comentário do `dotLedger` cita `ensureDotLedgerSchema` no `server` (que usa `assert`) | `dotLedger` linha 170 | ajustar comentário |

Detalhamento em `review/ledger-dependency-matrix.md` e `review/ledger-risk-register.md`.

## 3. Contratos entre componentes

- **`dotRoutes` → `dotLedger` → `groqService` → `aiUsage`:** ✅ íntegro. `dotRoutes` importa e usa todos os símbolos do ledger; `callAI` aceita `skipUsageRecord`; `recordAiUsage` grava in/out.
- **`server` → scheduler/worker → ledger:** ✅ íntegro **após C2**. `assertDotLedgerSchema` existe; `stopDotMonitorScheduler`/`stopDotAgentWorkerAndDrain` existem.
- **Assinaturas:** conferidas em `ledger-dependency-matrix.md §2`; sem divergência de parâmetros/tipos nas propostas.
- **Duplicadas/obsoletas:** `checkDotTokenBudget`/`dotTokenReservations`/`releaseDotTokenReservation` removidas; `runDotAgentWorkerTick` preservado; `ensureDotLedgerSchema` duplicada (I3).

## 4. Migrações e schema

- **Fonte única** após a decisão de I3: `runCentralMigrations` → `migrateDotBudgetLedger` (cria tabela + 3 índices; adiciona `tokens_input`/`tokens_output`/`sent_at` idempotentes).
- **Índice único parcial** `ux_dot_budget_reservations_ai_usage (ai_usage_id) WHERE ai_usage_id IS NOT NULL` — compatível SQLite/PostgreSQL.
- **Sem DDL por requisição:** os caminhos de requisição chamam apenas `assertDotLedgerSchema` (0 DDL).
- **Banco novo/legado:** coberto por `dotMigrationLegacy.test` (inspeção estática do teste; **execução pendente**).
- **Decisão obrigatória:** remover a DDL de `dotLedger` (ou transformá-la em validação) — hoje é uma **segunda implementação**.

## 5. Integridade financeira e contabilização

| Caminho | Implementação | Status |
|---|---|---|
| Reserva antes do envio | `reserveDotExecution` antes de `callAI` | ✅ |
| Marca de envio antes da chamada externa | `markDotReservationSent` antes de `callAI`; sem marca → 503 | ✅ |
| Falha comprovadamente anterior ao envio | `releaseDotReservation({provenNotSent:true})` | ✅ |
| Rejeição comprovada pelo provedor | `classifyDotProviderError` → `rejected` → libera | ✅ |
| Timeout/desconexão/ambíguo | `ambiguous` → reserva **aberta**, orçamento comprometido | ✅ |
| Finalização idempotente | `UPDATE ... WHERE status='pending'` + `ai_usage_id` único | ✅ |
| Expiração de pendentes | sweep só de `pending` **sem** `sent_at` | ✅ |
| Preservação de enviadas | `sent_at` impede expiração por TTL | ✅ |
| Reconciliação com evidência | `settle` (tokens) / `release` (`provenNotSent`) | ✅ |
| Deduplicação de `ai_usage` | índice único parcial + transição condicional | ✅ |
| Isolamento por tenant | todas as queries com `empresa_id` | ✅ |
| **Nenhuma falha ambígua libera orçamento** | verificado nos hunks de `settleDotCallFailure` | ✅ |

## 6. Groq e contabilização de tokens

- `skipUsageRecord: true` no Dot; `callAIReal` **não** grava `ai_usage` quando a flag está ligada → o ledger é a fonte única (sem dupla contagem). ✅
- Tokens de entrada/saída capturados (Groq `prompt_tokens`/`completion_tokens`; Gemini `promptTokenCount`/`candidatesTokenCount`). ✅
- Erros antes/depois do envio classificados por `dotProviderOutcome`. ✅
- `setCallAIImpl` **restrito a `NODE_ENV==='test'`**; os testes setam `NODE_ENV=test` (verificado). ✅
- **Nenhum caminho alternativo contorna o ledger** no DOT: só `routes/dotRoutes.ts` chama `callAI` (chat/explain), ambos sob ledger; `leadAutomation.ts` é feature distinta. ✅

## 7. Planos e fail-closed (#141)

- `normalizePlan` no gate e no `dotLedger` adaptado; `normalizePlanForQuota` retorna `''` para desconhecido. ✅
- **Sem** `|| 'rei'`/`|| 'Rei'` nas propostas (grep = 0). ✅
- Plano desconhecido ⇒ `getFeatureTokenLimit(...,'dot')=0` ⇒ `reserveDotExecution` recusa. ✅
- `dotResponseTokenLimit` fail-closed (0 fora de `rei`/`corporativo`) — **mudança de comportamento** (R06) a confirmar no demo.
- Planos anuais/aliases preservados no SQL do scheduler e em `normalizePlan`. ✅
- Demonstração (`demo`) **não reserva** (companyId nulo). ✅

## 8. PostgreSQL e CI

- Guarda `assertSafeTestDatabaseUrl`: localhost-only + `FILTERA_PG_TEST_ALLOWED_HOSTS`. ✅
- **Lacuna resolvida (proposta C3):** `dotExecutionAtomicity.pg.test`/`dotActionConcurrency.pg.test` passam a usar `databaseUrl()` (não o `process.env` cru). **O step do CI não é suficiente** para execuções locais — por isso a correção nos próprios testes.
- CI: `postgres:17`, `--encoding=UTF8 --locale=C`, `LC_ALL/LANG=C`, guard step, `'chore/**'` preservado. ✅
- `run-tests.mjs` usa `--test-concurrency=1`. ✅
- Sem colisão de fixtures (bancos/tenants distintos). ✅

## 9. Scheduler, worker e shutdown

- **Promessa única:** `scheduleTick` (worker) e `currentRun` (scheduler) — sem ticks simultâneos. ✅
- **Drain:** `stopDotAgentWorkerAndDrain`/`stopDotMonitorScheduler` aguardam o tick; timeout **não** é reportado como drenado. ✅
- **`server`:** fecha HTTP → para timers sync → drena DOT → `closeDB()` **1×**; loga o resultado de cada drain. ✅
- **Corrida start×drain:** documentada; no ciclo real (boot/shutdown) não ocorre. ⚠️
- **Lacuna I5:** retry/acquisition/replenisher/monthly report só param o timer. **Solução concreta:** aplicar o mesmo padrão (promessa-em-voo + `stopXAndDrain(ms)`) nesses módulos; enquanto isso, o `closeDB()` pode ocorrer com tick em voo (risco logado).
- **`server.close()` não encerra operações de banco já iniciadas** — por isso a drenagem explícita; para os módulos sem drain, resta o risco residual.

## 10. Rotas e segurança

- CSRF (`X-Dot-Csrf`), `requireMutationPermission`, `requireDotAdminSession`, separação aprovação/execução, isolamento por tenant: **preservados** nas propostas. ✅
- **Fail-closed** quando o ledger não está disponível: `server` só ativa o DOT com `dotLedgerReady`. ✅
- Rotas de orçamento (`/admin/budget`, `/admin/budget/reconcile`) exigem proprietário + sessão + `X-Dot-Admin`. ✅
- **Gancho de teste removido** na proposta final (`dotRoutes` v2): `grep -c "filtra.test.auth"` = **0**. ✅

## 11. Decisões obrigatórias antes da implementação

1. **R03/I3** — fonte única de DDL: remover/delegar `ensureDotLedgerSchema` e remover `ready()` morto.
2. **R05/I5** — implementar drain de retry/acquisition/replenisher/monthly report **ou** aceitar formalmente o risco residual.
3. **R06** — confirmar o fail-closed de `dotResponseTokenLimit` (demo).
4. **R02/I2** — adotar `dotRoutes` **v2** e migrar os 2 testes HTTP para JWT real.
5. **R04/I4** — adotar as propostas C3 dos testes PG.

## 12. Testes necessários por componente

| Componente | Testes |
|---|---|
| `dotProviderOutcome` | `dotProviderOutcome.test` (408/429/5xx/conexão/estruturado) |
| `dotLedger` | `dotLedger.test`, `dotSentReservation.test`, `dotLedger.pg.test` |
| `migrations`/`aiUsage` | `dotMigrationLegacy.test`, `dbMigrationsGuards.test` |
| `groqService` | `aiUsageDedup.test` |
| `dotRoutes`/`dotAdminRoutes` | `dotChatLedger.http.test`, `dotExplainLedger.http.test`, `dotAdminBudget.http.test`, `dotRouteProtection.test`, `dot-plan-identification.test` |
| scheduler/worker/server | `workerSchemaBootstrap.test` (#143), `dotSchedulerDrain.test`, `dotWorkerTickShare.test`, `dotShutdown.test`, `dotShutdownDrain.test`, `dotExecutionFlow.test` |
| PG/CI | `pgTestUtilsSafety.test`, `dotExecutionAtomicity.pg.test`, `dotActionConcurrency.pg.test` |

## 13. Critérios objetivos de aprovação

1. `npm run build` (tsc) **exit 0** com todas as propostas aplicadas.
2. `npm test` **100% verde** (inclui #141/#142/#143/atomicidade/SOD).
3. `npm run test:postgres` verde contra PG 17 local (locale C), **sem** banco remoto.
4. `dotAdminBudget.http.test` 14/14; chat/explain verdes com **JWT real**.
5. `grep -c "filtra.test.auth"` = 0 no `dotRoutes` final.
6. `grep -c "\|\| 'rei'\|\|\| 'Rei'"` = 0 nas propostas.
7. Uma única fonte de DDL (`migrateDotBudgetLedger`); `ensureDotLedgerSchema` sem DDL independente.
8. Índice único parcial presente em SQLite e PG; retry não duplica `ai_usage`.
9. `closeDB()` chamado **1×**; drains reportam drenado vs timeout.
10. Testes PG usam `databaseUrl()` (guard) — nenhum lê `process.env.DATABASE_URL` cru.

## 14. Conclusão

A revisão encontrou **2 P0** (imports `stop*` ausentes; gancho de teste em produção) e **3 P1** (DDL duplicada; bypass do guard PG; drain ausente). Foram produzidas **correções** para os P0 e para o bypass do guard PG. O ledger é financeiramente sólido (reserva→marca→finalize/ambíguo), fail-closed por plano e isolado por tenant. **Recomendação: não implementar antes de resolver as 5 decisões da §11**; com elas, o lote está apto à implementação na ordem de `ledger-implementation-sequence.md`, seguida dos gates da §13.
