# Revisão de integração — DOT Ledger / backend

Data: 2026-11-08
Repositório: `C:\Users\lucas\backend-pr139-integration`
Branch revisada: `reconcile/dot-production-2026-11-06`
HEAD revisado: **`e8345a6b73689b369fe2f640a246a59819b02f68`**
Base declarada: `a907a345bd38523b1b984364235686f3641a7700`

**Escopo:** revisão e documentação. Nenhum código foi alterado nesta tarefa; nenhum
stash aplicado; nenhum push de implementação, PR, merge ou deploy. Testes apenas
locais (cluster PostgreSQL 17.11 descartável em WSL2, loopback).

---

## 1. SHAs e grafo

| Ref | SHA |
|---|---|
| `origin/master` | `a2e3f6bafd3ec1ad1d2a641ddad08d7690197a88` |
| `origin/HEAD` | `a2e3f6bafd3ec1ad1d2a641ddad08d7690197a88` |
| Branch local (`reconcile/dot-production-2026-11-06`) | `e8345a6b73689b369fe2f640a246a59819b02f68` |
| Base declarada | `a907a345bd38523b1b984364235686f3641a7700` |
| `audit/dot-ledger-2026-11-06` (local e remoto) | `f530f67df977638f2dc9e348e82b6c9ce8307d9a` |
| PR #143 (merge em master) | `a2e3f6bafd3ec1ad1d2a641ddad08d7690197a88` |
| PR #139 head remoto | `5b893edc93b5e33a3df0ce19e41d347ab77b7843` |

```
a2e3f6b (origin/master = origin/HEAD)
 ├─ d6c33fb  #141 fail closed on unidentified plans
 ├─ 85b3b09  #142 CORS Render
 └─ a2e3f6b  #143 cache background worker schema bootstrap
        │
        └── 43 commits até HEAD:
            39 replays de PR #139 (SHAs novos)
            a907a34  docs(pr139) referência do deploy externo
            b69bf3b  lote 1 — ledger + migrações + provider outcome
            6f63380  lote 2 — aiUsage + groqService
            70a106b  lote 3 — dotRoutes v2 + dotAdminRoutes
            932a2d0  lote 4 — drain/shutdown/CI PostgreSQL
            e8345a6  correção da corrida sweep × finalize
```

`git merge-base HEAD origin/master = a2e3f6b` ⇒ **o HEAD já contém todo o master
atual** (nada a rebasear). `a2e3f6b..HEAD` = 43 commits; `a907a34..HEAD` = 5
commits (4 lotes + correção).

`a907a34` **não** é filho direto do master: seu pai é `5627b56`, o replay de
`ed0a972` (PR #139). Isto é consistente com o rebase declarado; não é divergência
funcional.

---

## 2. Estado de master, PR #139 e PR #143

- **master**: `a2e3f6b`, com #141 (`d6c33fb`), #142 (`85b3b09`) e #143 (`a2e3f6b`).
- **PR #139**: head `5b893edc` **não é ancestral** do master nem do HEAD
  (`merge-base = b8caf40`). Contagens `--left-right`:
  - PR139 × master: **39 / 4** (39 commits do PR fora do master; 4 do master fora do PR);
  - PR139 × HEAD: **39 / 47**.
- **Relação real**: a branch local é o **replay de PR #139 sobre o master atual**,
  seguido dos lotes. `git range-diff b8caf40..5b893edc a2e3f6b..a907a34`:
  - **28 pares idênticos (`=`)**, incluindo os commits funcionais críticos
    (atomicidade, CSRF, ator, row locks, workers PG, retenção, bootstrap de schema);
  - **1 divergente (`!`)**: `1ca13cb` ↔ `29c5cf3`. A única diferença é
    `routes/dotRoutes.ts` usando `normalizePlan` em vez de `normalizePlanAlias` —
    integração deliberada e necessária do #141 (o alias não é fail-closed);
  - **1 só no PR (`<`)**: `5b893ed` "remove obsolete Jatai deployment audit
    document". Conteúdo já coberto: `c4db20c` (master) removeu Jatai/Deno e
    `git ls-tree HEAD | grep -iE 'jatai|deno'` não retorna nada.
- **PR #143**: mesclado em `a2e3f6b`; o HEAD o contém integralmente.

**Consequência:** não há conteúdo do PR #139 faltando no HEAD, exceto a remoção
documental já coberta pelo master.

---

## 3. Arquivos com sobreposição (#143 × Lote 4)

| Arquivo | #143 (master) | Lote 4 (HEAD) | Situação |
|---|---|---|---|
| `lib/retryQueue.ts` | cache `retryQueueSchemaReady` (WeakMap) com retry após falha (l. 24–67) | `stopRetryWorker` (l. 296) + `retryTimer.unref()` (l. 325) | **ambos preservados** |
| `lib/acquisitionEngine.ts` | cache `acquisitionSchemaReady` (WeakMap) + retry (l. 45–107) | `stopAcquisitionWorker` (l. 482) + unref (l. 502) | **ambos preservados** |
| `services/dotAgentWorker.ts` | catch de falha transitória em `runDotAgentWorkerTick` (l. 59–67) | `tickInFlight`/`stopped`/`scheduleTick` (l. 18–20, 72–80) + `stopDotAgentWorkerAndDrain` (l. 137+) | **ambos preservados** |

Verificações semânticas:
- **cache por conexão**: `WeakMap<object, Promise<void>>` chaveado pelo handle do
  banco, com `delete` em caso de falha (permite novo bootstrap) — intacto;
- **retry do bootstrap**: `setup.catch(...)` remove a entrada para a próxima
  tentativa — intacto;
- **captura de transitórias**: `runDotAgentWorkerTick` envolve o tick em
  `try/catch` com `console.warn` e nunca rejeita — intacto;
- **stop dos timers**: `clearInterval` + `timer = null` nos três workers;
- **ticks concorrentes**: `tickInFlight` devolve a promessa em voo
  (inicialização, timer e `wakeDotAgentWorker` compartilham a mesma porta);
- **stopAndDrain**: aguarda `tickInFlight` com teto de 5s e `unref` no guarda;
- **shutdown/logs**: `server.ts` para HTTP → timers síncronos → drena DOT
  (scheduler e worker) → `closeDB()` uma única vez, com logs distintos.

---

## 4. Conflitos reais ou potenciais

**Reais:** nenhum. O HEAD já é descendente do master (`merge-base = a2e3f6b`), e
a aplicação sequencial preservou as duas implementações.

**Potenciais:**
1. **Processo/PR**: PR #139 continua aberto com 39 commits de SHAs antigos. Se
   ele for mesclado depois desta branch, o mesmo conteúdo entra duas vezes
   (conflitos em ~13 arquivos, incluindo `retryQueue`/`acquisitionEngine`).
   Recomendação: **encerrar o PR #139 em favor desta branch** (ou usá-la como
   substituta), não mesclar os dois.
2. **Rebase futuro**: se o master voltar a mexer em `services/dotLedger.ts`
   (SQL do sweep), `services/dotAgentWorker.ts` ou `server.ts`, o rebase dos 5
   commits pode conflitar — hoje não ocorre.
3. **Duplicidade de `normalizePlanAlias`**: `lib/quota.ts` ainda usa o alias
   (fora do caminho fail-closed do Dot); não é regressão, mas é uma inconsistência
   a acompanhar.

---

## 5. Compatibilidade das migrations

`lib/migrations.ts` → `migrateDotBudgetLedger` (executada por `initDB`, sob o
advisory lock global em PostgreSQL):

- `createTableIfMissing('dot_budget_reservations', …)` — tabela **nova**;
- `createIndexIfMissing`: `idx_…_empresa`, `idx_…_exec` e o **índice único
  parcial** `ux_dot_budget_reservations_ai_usage … WHERE ai_usage_id IS NOT NULL`;
- `addColumnIfMissing` em `ai_usage`: `provider`, `feature`, `tokens_input`,
  `tokens_output`;
- `addColumnIfMissing` em `dot_budget_reservations`: `sent_at`.

Tudo **aditivo e idempotente**, sem `DROP`, sem `UPDATE` de backfill e sem
`NOT NULL` sem default em tabela existente. O shim PG traduz
`INTEGER PRIMARY KEY AUTOINCREMENT` → `SERIAL PRIMARY KEY`.

Riscos operacionais: `CREATE INDEX` (não `CONCURRENTLY`) sobre `ai_usage` pode
segurar escrita por instantes na primeira execução em produção. Não executei
migration contra Supabase/produção (proibido); a compatibilidade foi exercitada
no PostgreSQL 17.11 descartável via `initDB` nos testes.

---

## 6. Revisão funcional (principais garantias)

| Arquivo | Garantia verificada |
|---|---|
| `services/dotLedger.ts` | reserva/finalize transacionais, `pg_advisory_xact_lock` por tenant, `SELECT … FOR UPDATE`, índice único parcial, classificação ambígua, sweep com predicados de estado no WHERE externo (correção `e8345a6`), `duplicate` só com `settled` confirmado |
| `services/dotProviderOutcome.ts` | 429/408/5xx **ambíguos** por padrão; `rejected` só com `NOT_PROCESSED_EVIDENCE`; `not_sent` só com evidência de não envio |
| `lib/aiUsage.ts` | schema aditivo (`provider`, `feature`, `tokens_input`, `tokens_output`); nenhuma deduplicação própria (a dedup é do ledger) |
| `groqService.ts` | `setCallAIImpl` lança fora de `NODE_ENV=test`; `skipUsageRecord` evita consumo duplo; repassa `input_tokens`/`output_tokens` |
| `routes/dotRoutes.ts` | `normalizePlan` (#141, fail-closed), `X-Dot-Csrf: 1` obrigatório em mutações, `dotUserActor(access.userId)` com `DotActorIdentityError` |
| `routes/dotAdminRoutes.ts` | `requireDotAdminSession`; budget/reconcile sempre escopados por `gate.empresaId` |
| `services/dotScheduler.ts` | `currentRun` compartilhado, `stopped`, `stopDotMonitorScheduler` com teto e `unref` |
| `services/dotAgentWorker.ts` | ver seção 3 |
| `server.ts` | ordem de shutdown; `dotLedgerReady` **fail-closed** (DOT responde 503 sem schema validado) |
| `lib/migrations.ts` | ver seção 5 |

---

## 7. Testes executados

Ambiente: WSL2 Ubuntu 26.04, Node v22.22.1, PostgreSQL **17.11** descartável
(`127.0.0.1:55433`, `datcollate=C`, `datctype=C`, `UTF8`), banco
`filtra_ledger_test`, usuário `filtra_test`. Cópia exata do HEAD via
`git archive e8345a6` (manifesto de `tests/services/lib/routes` =
`b52536623dad7f45dc5f5445e7ce047cfd52489afcc7d12604cd51d70f576694`).

| Comando | Exit | Resultado | Log |
|---|---:|---|---|
| `npx tsc --noEmit` (Windows) | 0 | sem erros | — |
| `node ./node_modules/typescript/bin/tsc --noEmit` (WSL) | 0 | sem erros | `review/pg17-logs/tsc.log` (vazio) |
| `npm run test:postgres` (WSL) | 0 | **35/35** (11 arquivos), 0 fail/skip | `review/pg17-logs/test-postgres-review.log` |
| `npm test` (WSL, não-PG) | 0 | **431/431**, 0 fail/skip | `review/pg17-logs/sqlite-review.log` |

Concorrência/atomicidade cobertas pela suíte PG: `dotActionConcurrency.pg`
(2 processos), `dotExecutionAtomicity.pg` (5), `dotLedger.pg` (6, com workers),
`dotLedgerRace.pg` (7, incluindo 8 iterações concorrentes sweep × finalize).

Hashes SHA-256 dos logs:

| Arquivo | SHA-256 |
|---|---|
| `tsc.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (vazio) |
| `test-postgres-review.log` | `c223952110a50086c81dca47338249131f7cd613f3e75d9eb2508d0bfe22b9e9` |
| `sqlite-review.log` | `6695eae5876a206157707edbd773a0ffd21b47a0c6cee46a65d8358b67363ab4` |

### CI e workflows

Somente `.github/workflows/ci.yml` mudou em relação ao master (`deploy-oracle.yml`
e `dependency-audit.yml` intactos). O job `postgres-concurrency` usa
`postgres:17` com `POSTGRES_INITDB_ARGS="--encoding=UTF8 --locale=C"`,
`LC_ALL=C`, Node 20, guarda que recusa `DATABASE_URL` não local e executa
`npm run test:postgres`. Sintaxe e passos compatíveis com a suíte validada.

---

## 8. Riscos residuais (mantidos documentados)

1. `retryQueue`, `acquisitionEngine` e `acquisitionReplenisher` param apenas o
   timer; **não drenam** promises em voo no shutdown.
2. Corrida **start × drain** no scheduler/worker: `stop` marca `stopped` antes de
   drenar e `scheduleTick` respeita o flag; um `start()` concorrente ao `drain`
   pode reabilitar ticks — documentado, não ocorre no ciclo real de boot/shutdown.
3. `dotAdminPin` — flake pré-existente (decisão D1), fora da suíte PG.
4. `CREATE INDEX` não concorrente na primeira migration em produção (janela curta).
5. Disposição do PR #139 (seção 4).
6. Testes não-PG executados no WSL por saturação do `%TEMP%` do Windows; o alvo
   é o mesmo do CI (Linux).

---

## 9. Correções necessárias

**Nenhuma correção de código** para a integração: as suítes PG/SQLite e o `tsc`
passam no HEAD exato, sem conflito real e com migrations aditivas.

Separado do já validado (decisão de processo, não de código): **encerrar ou
substituir o PR #139** por esta branch, para não mesclar duas linhagens do mesmo
conteúdo.

---

## 10. Decisão

**APROVADO para preparar PR** — com a ressalva processual de não mesclar PR #139
e esta branch em paralelo.

Justificativa: HEAD contém todo o master (`a2e3f6b`); o replay de PR #139 é fiel
(28 pares idênticos; 1 divergência intencional e necessária do #141; remoção
Jatai já coberta); #143 e o Lote 4 coexistem sem perda de cache, retry, captura
de transitórias, stop de timers, prevenção de ticks concorrentes ou drain;
migrations aditivas; 35/35 PG, 431/431 SQLite, `tsc` limpo.

Nenhum ponto essencial ficou sem teste **local**. A migration de produção não foi
executada (proibido) e permanece como verificação operacional no deploy.
