# DSV4 — Registro de riscos do DOT Durable Token Ledger

**HEAD auditado:** `a907a345bd38523b1b984364235686f3641a7700` · Revisão estática. Nenhum teste executado.

| ID | Sev | Título | Evidência | Impacto | Correção recomendada | Teste de regressão |
|---|---|---|---|---|---|---|
| R01 | **P0** | `server.ts` importa `stop*` inexistentes | `server.ledger.proposed.ts.txt:81,87,88` importam `stopRetryWorker`/`stopAcquisitionWorker`/`stopAcquisitionReplenisher`; `grep` no HEAD → **ausentes**; sem proposta no lote anterior | **Build falha** (`TS2305`), servidor não sobe | **Criadas** `review/retryQueue.*`, `acquisitionEngine.*`, `acquisitionReplenisher.*` (stop* + timer `unref`) | `npm run build`; boot do servidor |
| R02 | **P0** | `dotRoutes` com gancho `filtra.test.auth` | `dotRoutes.ledger.proposed.ts.txt:189,196` (`routesApp`/`filtra.test.auth`) | Superfície de autenticação só-de-teste no código de produção | **Criada** `dotRoutes.ledger.proposed.v2.ts.txt` **sem** o gancho; migrar `dotChatLedger.http.test`/`dotExplainLedger.http.test` para JWT real (`signAccessToken` + `Authorization`, como `dotAdminBudget.http.test`) | `grep -c filtra.test.auth` = 0; testes HTTP com JWT real |
| R03 | **P1** | DDL duplicada (`ensureDotLedgerSchema` × `migrateDotBudgetLedger`) | Ambos com `CREATE TABLE IF NOT EXISTS dot_budget_reservations`; colunas `tokens_input/tokens_output/sent_at` nos dois | Duas implementações de schema podem divergir | Migração central como **fonte única**; remover a DDL de `dotLedger` (ou torná-la delegação/validação). `ready()` está **morto** — remover | `dotMigrationLegacy.test`; `dbMigrationsGuards.test` |
| R04 | **P1** | Testes PG leem `DATABASE_URL` direto (bypass do guard local) | `dotExecutionAtomicity.pg.test.ts:23` e `dotActionConcurrency.pg.test.ts:16,17,21,76` usam `process.env.DATABASE_URL`; `databaseUrl()` = 0 usos | Execução **local** de `npm run test:postgres` pode rodar contra banco remoto/produção | **Criadas** `dotExecutionAtomicity.pg.test.proposed.ts.txt` e `dotActionConcurrency.pg.test.proposed.ts.txt` usando `databaseUrl()` | `pgTestUtilsSafety.test`; `test:postgres` com host remoto deve recusar |
| R05 | **P1** | Sem drain para retry/acquisition/replenisher/monthly report | `server` proposto só para timers (`stop*` sync); HEAD não tem drain | `closeDB()` pode ocorrer com tick em voo nesses workers | Adicionar promessa-em-voo + `stopXAndDrain(ms)` em cada módulo (padrão do worker DOT) **ou** aceitar/documentar (ticks curtos) | `dotShutdownDrain.test` (estender) |
| R06 | **P1** | `dotResponseTokenLimit` fail-closed altera demo | Proposta retorna **0** para plano fora de `rei`/`corporativo` (antes 900) | Chat demo sem plano identificado usaria teto 0 | Confirmar consumidores; em demo o gate já define `plan='rei'` | `dotChatLedger.http.test` (demo) |
| R07 | **P2** | `setCallAIImpl` guardado a teste | `groqService` proposto lança fora de `NODE_ENV==='test'` | Uso legítimo fora de teste quebraria | Manter guard; os testes setam `NODE_ENV=test` (verificado em `aiUsageDedup`/`dotChatLedger`) | `aiUsageDedup.test` |
| R08 | **P2** | `getTokenLimit('')` cai em `trial` | `lib/quota.ts` `getTokenLimit` usa `normalizePlanAlias(plan) || 'trial'` | Campo `feedback_token_limit` (não o orçamento Dot) com valor de trial para plano ausente | Aceitável (é a cota de feedback); documentar | — |
| R09 | **P2** | `DEFAULT_RESPONSE_LIMIT` sem uso | Após fail-closed, o default 900 deixa de ser usado | Código morto | Remover em follow-up | `tsc` |
| R10 | **P3** | Comentário desatualizado no `dotLedger` | `dotLedger` linha 170 cita `ensureDotLedgerSchema` no `server`; o `server` usa `assertDotLedgerSchema` | Documentação enganosa | Corrigir comentário | — |
| R11 | **P3** | `dotExecutionAtomicity.pg.test` cria `dot_decisions` com DDL local | `CREATE TABLE IF NOT EXISTS dot_decisions` no teste, sobre `filtra_test` | Pode divergir da migração central | Usar a migração central/`ensureDecisionTable` compartilhado | `test:postgres` |

## Verificações estáticas concluídas

- ✅ **Nenhum caminho alternativo contorna o ledger**: no DOT, só `routes/dotRoutes.ts` chama `callAI` (chat/explain) e ambos usam o ledger. `leadAutomation.ts` usa `callAI` fora do DOT (feature distinta).
- ✅ `run-tests.mjs` usa `--test-concurrency=1`.
- ✅ Sem colisão de fixtures: `dotLedger.pg.test` cria banco próprio; atomicidade/concorrência usam tenant único no `filtra_test`.
- ✅ `dotProviderOutcome`: 408 ambíguo; 4xx/429/5xx estruturados = `rejected`; conservador.
- ✅ `#141`: `normalizePlan` no gate e no ledger; sem `|| 'rei'`/`|| 'Rei'` nas propostas.

## Pendências de validação dinâmica (não comprovadas por inspeção)

- Execução real de `withDbTransaction` + `pg_advisory_xact_lock` + `RETURNING id` no fluxo composto (PG).
- Comportamento do índice único parcial em corrida multi-processo real.
- Comportamento do drain sob timeout real.
