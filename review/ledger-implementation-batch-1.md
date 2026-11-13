# DSV4 — Implementação controlada do DOT Durable Token Ledger — Lote 1

**HEAD-base:** `a907a345bd38523b1b984364235686f3641a7700`
**Branch:** `reconcile/dot-production-2026-11-06` (inalterada)
**Escopo:** `services/dotProviderOutcome.ts`, `lib/migrations.ts`, `services/dotLedger.ts` + testes de ledger/provider/migração + helper PG.
**Não implementado neste lote:** Groq, rotas, scheduler, worker, server.

## 1. Artefatos de revisão usados (SHA-256)

| Artefato | SHA-256 |
|---|---|
| `review/dotProviderOutcome.ledger.proposed.ts.txt` | `31a86120c6ac45b825f15bc1ffa4a912e0e2a94fdcdd644b9b428989f879073c` |
| `review/migrations.ledger.proposed.ts.txt` | `e34e8ffff6b680e4584a0aa17f993fff76eba16572b1303dfa915be4c1eee673` |
| `review/dotLedger.ledger.proposed.ts.txt` | `0b1df531efcb29992e6ce18e88a75eb122c785fde0c9f566ff0ff189654684ca` |
| `review/pg-test-utils.ledger.proposed.ts.txt` | `464ed325ef2eed7a6553602f0b7fc585b2e42620aa6aa7d9a231f1db31329384` |
| `review/ledger-cross-review.md` | `e138226a59fc265db2af96375b5547f2f289df7931f0e7f17723eb84a2fafdd0` |
| `review/ledger-risk-register.md` | `c07405d368543f0bc0d5872944ee9089f7eb0dc4caf1f74e33bf13c143ac3ddb` |

## 2. Arquivos implementados

**Novos**
- `services/dotProviderOutcome.ts` — classificação `not_sent`/`rejected`/`ambiguous`. **Correção obrigatória aplicada:** `rejected` limitado a 4xx ESTRUTURADO (400/401/402/403/404/413/422); **408, 5xx e 429 são `ambiguous` por padrão**; um 429 só é `rejected` com evidência explícita de não processamento (`NOT_PROCESSED_EVIDENCE`).
- `services/dotLedger.ts` — ledger durável; **adaptações de revisão aplicadas**:
  - `ensureDotLedgerSchema()` agora **apenas valida** (`assertDotLedgerSchema`), **sem DDL própria**;
  - `ensureDotLedgerColumns()` (DDL) **removida**;
  - `ready()` (morto) **removida**;
  - `normalizePlan` (fail-closed #141) preservado; sem `|| 'rei'`.
- Testes: `tests/dotProviderOutcome.test.ts`, `tests/dotLedger.test.ts`, `tests/dotMigrationLegacy.test.ts`, `tests/dotSentReservation.test.ts`, `tests/dotLedger.pg.test.ts`, `tests/pgTestUtilsSafety.test.ts`, `tests/helpers/dot-ledger-worker.pg.ts`.

**Modificados**
- `lib/migrations.ts` — `migrateDotBudgetLedger` (tabela + 3 índices, incl. único parcial; colunas `tokens_input`/`tokens_output`/`sent_at`) + chamada em `runCentralMigrations`. **Fonte única de DDL.**
- `tests/helpers/pg-test-utils.ts` — guarda `assertSafeTestDatabaseUrl` (localhost-only + allowlist). Necessário para o teste PG seguro (o HEAD não tinha proteção).

## 3. Testes executados e resultados REAIS

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit` | **EXIT 0** |
| `node --import tsx --test --test-concurrency=1 tests/dotProviderOutcome.test.ts tests/dotLedger.test.ts tests/dotMigrationLegacy.test.ts tests/dotSentReservation.test.ts tests/pgTestUtilsSafety.test.ts` | **41/41 PASS** (5 suítes), EXIT 0 |
| `node --import tsx --test tests/dotLedger.pg.test.ts` | **BLOCKED** — `DATABASE_URL de teste PostgreSQL é obrigatória` (sem PG local; falha fechada, nenhuma conexão) |
| `node scripts/run-tests.mjs` (suíte completa) | ver §5 |

Cobertura relevante comprovada (SQLite):
- reserva/finalização/retry/ambiguidade/expiração/reconciliação (`dotLedger`);
- `sent_at` × sweep (abandonada expira; enviada **não** expira; além da carência vira ambígua); `sweep × finalize` → consumo único;
- migração de banco legado adiciona `sent_at`/`tokens_input`/`tokens_output` sem perder linhas;
- classificação de erro do provedor (408/429/5xx/conexão/estruturado);
- guarda anti-produção PG (recusa host remoto).

## 4. Diffstat

```
 lib/migrations.ts              | 70 ++++++++++++++++++++++++++++++++++++++++++
 tests/helpers/pg-test-utils.ts | 39 +++++++++++++++++++++++
 2 files changed, 109 insertions(+)
```
(+ 9 arquivos novos não rastreados)

## 5. Suíte completa

`node scripts/run-tests.mjs` → **376 testes · 375 pass · 1 fail · 74 arquivos · EXIT 1**.

**Única falha:** `tests/dotAdminPin.test.ts` → *“atraso progressivo e bloqueio temporário persistem no banco e expiram”*.

**Análise (evidência):**
- `dotAdminPin.test.ts` **não referencia** nenhum arquivo do lote 1 (grep = 0 para `dotLedger`/`dotProviderOutcome`/`migrations`/`pg-test-utils`).
- Passa **9/9 em isolamento**, 2 execuções consecutivas (EXIT 0).
- A falha é a **intermitência pré-existente** já registrada no relatório do PR #139: teste dependente de relógio real com janelas curtas (`lock_until = agora - 1s`), sensível à carga — a suíte roda 74 arquivos em sequência `--test-concurrency=1`.
- **Não é regressão do lote 1.** Corrigir exigiria injetar relógio determinístico no teste → **fora do escopo**.

**D1 APROVADA:** `dotAdminPin.test.ts` é falha intermitente **pré-existente e fora do escopo**; **não** será alterado nem receberá relógio determinístico. Evidência registrada: passa **9/9 em isolamento (2 execuções consecutivas)**; não referencia nenhum arquivo do lote 1. A suíte completa **não** será reexecutada para “eliminar” a falha.

## 5.1 Decisão D1 (resolvida)

- `dotAdminPin.test.ts` = falha intermitente **pré-existente, fora do escopo**; **não alterar** o teste nem o relógio. Registrada com evidência (9/9 isolado, 2×). Não bloqueia este lote.

## 6. Riscos e pendências para o lote 2

1. **PostgreSQL real BLOCKED (registrado):** **sem ambiente disponível** — `docker` tem binário mas o **daemon não responde**; porta 5432 fechada (`ECONNREFUSED`); sem `DATABASE_URL`. `dotLedger.pg.test.ts` (6 testes) e a matriz de concorrência multi-processo **NÃO foram executados**. `dotLedger.pg.test.ts` falha **fechado** (`DATABASE_URL de teste PostgreSQL é obrigatória`) — nenhuma conexão. **Este lote NÃO declara validação PostgreSQL concluída**; a pendência **bloqueia a aprovação final** para integração até `npm run test:postgres` verde em PG 17 descartável.
2. **`ensureDotLedgerSchema` agora é validação** — o worker PG (`tests/helpers/dot-ledger-worker.pg.ts`) e os testes chamam `initDB()` antes, então a tabela existe. Confirmar em PG real.
3. **DDL do ledger em um só lugar** — cumprido (0 ocorrências de `CREATE/ALTER` em `dotLedger.ts`).
4. **Fora do escopo do lote 1** (não implementados): `groqService` (`skipUsageRecord`/tokens/`setCallAIImpl`), rotas (`dotRoutes` v2, `dotAdminRoutes`), `dotScheduler`, `dotAgentWorker`, `server`, `retryQueue`/`acquisitionEngine`/`acquisitionReplenisher` (stop*), `ci.yml`, `.env.example`, correções PG de `dotExecutionAtomicity`/`dotActionConcurrency`.
5. **`dotProviderOutcome`/`dotLedger` sem consumidores de runtime ainda** — as rotas do lote 2 é que passam a usá-los.
