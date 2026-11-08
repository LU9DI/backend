# DSV4 — Implementação controlada do DOT Durable Token Ledger — Lote 4 (background, shutdown e CI)

**HEAD-base:** `70a106bef40510fc6d4187694738d0e95ba30a02`
**Branch:** `reconcile/dot-production-2026-11-06` (inalterada)
**Escopo:** `dotScheduler`, `dotAgentWorker`, `server.ts`, `retryQueue`, `acquisitionEngine`, `acquisitionReplenisher` (stop*), `ci.yml`, `.env.example`, correções PG de `dotExecutionAtomicity`/`dotActionConcurrency`, e testes de shutdown/scheduler/worker.

## 1. Artefatos de revisão usados (SHA-256)

| Artefato | SHA-256 |
|---|---|
| `review/dotScheduler.ledger.proposed.ts.txt` | `f5821560d5eb11fff6f08989d776f58b41f80324af30a54b35e759944929409e` |
| `review/dotAgentWorker.ledger.proposed.ts.txt` | `afa60a1a7dddacf5f2e68f21c2bd5efe3d0eaaa48a52c23c7a8d7c4ecb8dc4dc` |
| `review/server.ledger.proposed.ts.txt` | `90849d158f0e586f67589956eecdb037ebd82b009cf7b66fedf2a171206a84b9` |
| `review/retryQueue.ledger.proposed.ts.txt` | `a2a73b25b2ec462681e654582b32be66592d231ebccbbd971fb1aeabdb9b5763` |
| `review/acquisitionEngine.ledger.proposed.ts.txt` | `48b69740e24bf2e509069ce5efc004673cade9ef8af571b5d2b8c80d2c363a84` |
| `review/acquisitionReplenisher.ledger.proposed.ts.txt` | `de99310ff1132f8362ebeec730b1275641a37d2f2287b8e3b26f5ab75d5b19a9` |
| `review/ci.ledger.proposed.yml.txt` | `bf7283d0378348d27d0ee71c1b8decbae360be371c82aca0a50d9e8faa0f9081` |
| `review/env.example.ledger.proposed.txt` | `b01367a6f6f30bc8d372c80400e10c5a97c39669a4217f84263ad36741eca975` |
| `review/dotExecutionAtomicity.pg.test.proposed.ts.txt` | `5b69d0d0e19711013484fc674cdd6b09d68bd61a237174fb45603fd3e511206e` |
| `review/dotActionConcurrency.pg.test.proposed.ts.txt` | `5cfe316783b38ba0d88b63da70f3758da4965971b92273412153044c722d67d9` |

## 2. Arquivos alterados

**Modificados (10):**
- `services/dotScheduler.ts` — `currentRun`/`stopped`; `getDotSchedulerRuntimeStatus`; `stopDotMonitorScheduler` (timeout não reportado como drenado); **SQL de planos anuais (#141) preservado**.
- `services/dotAgentWorker.ts` — `scheduleTick` (promessa única) mantendo `runDotAgentWorkerTick` (#143); `in_flight`/`stopped`; `stopDotAgentWorkerAndDrain`.
- `server.ts` — `backgroundStops` só para timers síncronos; **DOT drenado UMA vez** (sem duplicar); `assertDotLedgerSchema` + `dotLedgerReady` (fail-closed do DOT); `closeDB()` 1×; log de drenagem/timeout.
- `lib/retryQueue.ts`, `lib/acquisitionEngine.ts`, `lib/acquisitionReplenisher.ts` — `stopRetryWorker`/`stopAcquisitionWorker`/`stopAcquisitionReplenisher` + timers `unref`.
- `.github/workflows/ci.yml` — `postgres:17`, locale C/UTF-8, guard local, `'chore/**'` preservado.
- `.env.example` — `DOT_SENT_GRACE_MS`, `FILTERA_PG_TEST_ALLOWED_HOSTS`.
- `tests/dotExecutionAtomicity.pg.test.ts`, `tests/dotActionConcurrency.pg.test.ts` — passam a usar `databaseUrl()` (guard anti-produção) em vez de `process.env.DATABASE_URL` cru.

**Novos (5):** `tests/dotSchedulerDrain.test.ts`, `dotWorkerTickShare.test.ts`, `dotShutdown.test.ts`, `dotShutdownDrain.test.ts`, `dotExecutionFlow.test.ts`.

## 3. Desvios das propostas (documentados)

1. **`dotScheduler`: TS2454.** A proposta usava `const run = (async () => { … finally { if (currentRun === run) … } })()` — auto-referência que o TypeScript rejeita (`Variable 'run' is used before being assigned`). Corrigido para `let run: Promise<void> | null = null; run = (…)`; **a proposta também foi atualizada** (`review/dotScheduler…` → `f5821560…`).
2. **`dotShutdown.test.ts`:** o teste do stash exigia `trackBackground('DOT scheduler'/'DOT agent worker')`; a proposta removeu essa duplicação (drain explícito). O teste foi alinhado ao design aprovado: retry/acquisition/monthly em `trackBackground`; DOT via `stopDotMonitorScheduler`/`stopDotAgentWorkerAndDrain` **antes** de `closeDB`; verificação explícita de **não** duplicar o DOT.

## 4. Testes executados — resultados REAIS

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit` | **EXIT 0** (após a correção TS2454) |
| `node --import tsx --test --test-concurrency=1` em `workerSchemaBootstrap`, `dotSchedulerDrain`, `dotWorkerTickShare`, `dotShutdown`, `dotShutdownDrain`, `dotExecutionFlow`, `dotMonitorConcurrency`, `dotMonitorResolve` | **32/32 PASS**, EXIT 0 |
| Suíte completa (`node scripts/run-tests.mjs`) | **ver §5** |

Cobre: scheduler (drain, idempotência, timeout, sem rodada nova), worker (promessa única, drain, `in_flight`, `runDotAgentWorkerTick` #143), `server.ts` (ordem HTTP→drain→closeDB, sem duplicar DOT, idempotência), execução real com ledger, monitor concorrência/resolução.

## 5. Suíte completa

`node scripts/run-tests.mjs` → **431 testes · 431 pass · 0 fail · 83 arquivos · EXIT 0** (1472 s). Inclui os 5 testes novos de shutdown/scheduler/worker e as regressões dos Lotes 1–3.

## 6. Diffstat

```
 .env.example                           |   7 ++
 .github/workflows/ci.yml               |  15 +++-
 lib/acquisitionEngine.ts               |  19 ++++-
 lib/acquisitionReplenisher.ts          | 143 +++++++++++++++++++++++++++++++--
 lib/retryQueue.ts                      |  13 ++-
 server.ts                              | 102 +++++++++++++++++++----
 services/dotAgentWorker.ts             |  80 ++++++++++++++++--
 services/dotScheduler.ts               |  79 +++++++++++++++++-
 tests/dotActionConcurrency.pg.test.ts  |  10 +--
 tests/dotExecutionAtomicity.pg.test.ts |   4 +-
 10 files changed, 430 insertions(+), 42 deletions(-)   (+ 5 testes novos)
```

## 7. Riscos e pendências

1. **PostgreSQL BLOCKED (herdado):** `dotExecutionAtomicity.pg.test.ts`, `dotActionConcurrency.pg.test.ts` e `dotLedger.pg.test.ts` continuam **não executados** (sem ambiente). As correções de guarda PG foram aplicadas, mas a validação depende de PG 17 descartável (locale C) → **bloqueia a aprovação final**.
2. **Drain de retry/acquisition/replenisher/monthly report:** só os timers são parados (não há promessa-em-voo drenável). Risco residual registrado no `server`.
3. **Corrida `start` × `drain`** no scheduler/worker: documentada; não ocorre no ciclo real de boot/shutdown.
4. **`dotScheduler` e `dotAgentWorker`** agora têm as versões com drain; o `server` integra ambas.
