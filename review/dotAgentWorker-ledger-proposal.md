# Filtra DOT — proposta de hand-merge de `services/dotAgentWorker.ts`

**Modo:** somente leitura. Nada aplicado. `services/dotAgentWorker.ts` **não** foi alterado.
**Repositório:** `C:\Users\lucas\backend-pr139-integration`
**Branch:** `reconcile/dot-production-2026-11-06`
**HEAD de referência:** `a907a345bd38523b1b984364235686f3641a7700`
**Fontes:** `stash@{0}` (rastreado) e `stash@{0}^3` (novos).

---

## 1. Artefatos

| Artefato | Caminho | Linhas | Bytes | MD5 | SHA-256 |
|---|---|---|---|---|---|
| Arquivo final proposto | `review/dotAgentWorker.ledger.proposed.ts.txt` | 152 | 6058 | `f914424b773123ec55133b6c5bf1f609` | `afa60a1a7dddacf5f2e68f21c2bd5efe3d0eaaa48a52c23c7a8d7c4ecb8dc4dc` |
| Diff HEAD → proposta | `review/dotAgentWorker.ledger.proposed.diff` | 121 | 4815 | `920a2c8a42110728e03bf3e40e8a2e6d` | `81aca6517980ad9866fb001798a7bd5f41bd68a4504086748c76a0f665498a87` |

Diff: `1 file changed, 72 insertions(+), 8 deletions(-)`. Emitido em CRLF para diff mínimo. `.txt` para não entrar no `tsconfig`.

## 2. Justificativa por alteração

| # | Alteração | Justificativa |
|---|---|---|
| 1 | comentário de `tickInFlight` atualizado | documenta que a promessa é compartilhada por boot, timer, wake e drain |
| 2 | `+ let stopped = false` | impede que um tick NOVO inicie durante/após o shutdown; liberado no `start` |
| 3 | `+ function scheduleTick()` | **porta única**: devolve a promessa em voo; nunca rejeita (usa `runDotAgentWorkerTick`, que contém o erro) |
| 4 | `startDotAgentWorker`: `runDotAgentWorkerTick()` → `scheduleTick()` (boot e timer) | elimina a possibilidade de dois ticks simultâneos entre boot e timer |
| 5 | `startDotAgentWorker`: `+ stopped = false` | permite reinício explícito após parada |
| 6 | `wakeDotAgentWorker` retorna `scheduleTick()` | reusa o tick em voo em vez de criar uma promessa paralela |
| 7 | `getDotAgentWorkerStatus`: `+ in_flight`, `+ stopped` | expõe execução em andamento e estado de shutdown |
| 8 | `+ stopDotAgentWorkerAndDrain(timeoutMs = 5_000)` | drena o tick em andamento antes de fechar o pool; timeout com guarda `unref` |
| 9 | `runTick` **inalterado** | preserva locks duráveis, transações, idempotência e bootstrap de schema |
| 10 | `runDotAgentWorkerTick(task = runTick)` **inalterado** | contrato do PR #143 usado por `tests/workerSchemaBootstrap.test.ts` |
| 11 | `stopDotAgentWorker()` **inalterado** | continua "para só o timer", sem mexer no tick em voo (compatibilidade) |

## 3. Análise de concorrência e shutdown

**Porta única (`scheduleTick`).** Toda entrada (boot, timer, `wake`) passa por ela; se já existe `tickInFlight`, devolve a mesma promessa. Assim `runTick` nunca roda em paralelo consigo mesmo (além da guarda `running` dentro de `runTick`, mantida).

| Cenário | Comportamento |
|---|---|
| `start` + `wake` no mesmo instante | um único tick (segundo recebe a promessa em voo) |
| tick de timer + `wake` | reusa o tick em voo |
| `stop`/drain + `wake` | `stopped=true` → `scheduleTick` devolve `Promise.resolve()`; **nenhum** tick novo |
| `stop` + `stop` | idempotente (`clearInterval` seguro; `stopped=true`) |
| `start` + `start` | `if (timer) return` → um único timer |
| `runDotAgentWorkerTick(customTask)` (teste) | caminho direto; não mexe em `tickInFlight` |
| `stop` (bare) + `wake` | `stopDotAgentWorker` **não** seta `stopped`; `wake` ainda roda — comportamento idêntico ao HEAD |

**Shutdown (`stopDotAgentWorkerAndDrain`).**
1. `stopped = true` (barra ticks novos);
2. `stopDotAgentWorker()` (limpa o timer);
3. captura `tickInFlight`; se não há, retorna `{drained:true}`;
4. `Promise.race([inFlight.catch(()=>undefined), guard])` com timeout `unref()`ed;
5. retorna `{drained: !timedOut, running}`.

Quando `inFlight` assenta sem timeout, o `finally` de `scheduleTick` já zerou `tickInFlight` — logo `in_flight:false`. Em timeout, `tickInFlight` permanece (correto: ainda há trabalho). O `server.ts` faz `process.exit` em seguida.

**Reservas ambíguas do ledger.** O worker **não** toca `services/dotLedger.ts`. Reservas com `sent_at` só mudam por `finalize`/`reconcile` (ou sweep, que nunca expira enviada). O drain apenas aguarda; **não** libera nada.

## 4. Compatibilidade com o PR #143

`tests/workerSchemaBootstrap.test.ts` importa `runDotAgentWorkerTick` e verifica:
- `assert.doesNotReject(() => runDotAgentWorkerTick(async () => { throw ... }))` — preservado (o `try/catch` com `console.warn` continua);
- `console.warn` chamado — preservado.

O bootstrap de schema (`ensureRetryQueue`/`ensureAcquisitionEngineSchema`) **não** é tocado por este arquivo. Os hunks do ledger em `lib/retryQueue.ts`/`lib/acquisitionEngine.ts` são apenas timers/`stop*` no fim do arquivo (integração separada).

## 5. Dependências de integração (scheduler e servidor)

`server.ts` (delta do ledger) precisará importar:

| Função | Assinatura real | Origem | Arquivo do HEAD tem? |
|---|---|---|---|
| `stopDotAgentWorkerAndDrain` | `(timeoutMs = 5_000) => Promise<{ drained: boolean; running: boolean }>` | **esta proposta** | ❌ (a adicionar) |
| `stopDotMonitorScheduler` | `(timeoutMs = 5_000) => Promise<{ stopped: boolean; in_flight: boolean }>` | `stash@{0}:services/dotScheduler.ts:248` | ❌ |
| `getDotSchedulerRuntimeStatus` | `() => { timer_active: boolean; running: boolean; in_flight: boolean }` | `stash@{0}:services/dotScheduler.ts:236` | ❌ |
| `stopRetryWorker` | `() => void` | `stash@{0}:lib/retryQueue.ts:278` | ❌ |
| `stopAcquisitionWorker` | `() => void` | `stash@{0}:lib/acquisitionEngine.ts:462` | ❌ |
| `stopAcquisitionReplenisher` | `() => boolean` | `stash@{0}:lib/acquisitionReplenisher.ts:602` | ❌ |
| `stopMonthlyReportScheduler` | `() => void` | HEAD `services/monthlyReportScheduler.ts:125` | ✅ |

Ordem: integrar as funções `stop*` **antes** do `server.ts`, senão o import falha.

## 6. Status operacional (`getDotAgentWorkerStatus`)

| Campo | Campo do HEAD | Proposta | Significado |
|---|---|---|---|
| `disabled` | ✅ | ✅ | `DOT_AGENT_WORKER_ENABLED === '0'` |
| `timer_active` | ✅ | ✅ | timer do `setInterval` ativo |
| `running` | ✅ | ✅ | `runTick` em execução |
| `in_flight` | ❌ | ✅ (novo) | qualquer tick (boot/timer/wake) em voo |
| `stopped` | ❌ | ✅ (novo) | shutdown/drain aplicado |
| `interval_ms` | ✅ | ✅ | intervalo efetivo |

## 7. Testes necessários

| Teste | O que cobre |
|---|---|
| `tests/workerSchemaBootstrap.test.ts` (HEAD, #143) | `doesNotReject` + `console.warn` de `runDotAgentWorkerTick` (**obrigatório**) |
| `tests/dotWorkerTickShare.test.ts` (stash) | promessa única por tick, `in_flight`, idempotência |
| `tests/dotSchedulerDrain.test.ts` (stash) | `in_flight`/drain do scheduler (arquivo separado) |
| `tests/dotShutdown.test.ts` / `dotShutdownDrain.test.ts` (stash) | shutdown do worker/scheduler |
| `tests/dotExecutionFlow.test.ts` (stash) | fluxo de execução com ledger |

**Verificações somente leitura executadas nesta etapa:** sintaxe via `typescript.transpileModule` → **SINTAXE OK (153 linhas)**; checagens estáticas (export de `runDotAgentWorkerTick` preservado; `scheduleTick`/`stopped`/`in_flight`/`stopDotAgentWorkerAndDrain` presentes; `runTick` sem alterações). **Nenhum teste foi executado** (arquivo não aplicado).

## 8. Riscos e incompatibilidades pendentes

**P0** — nenhum novo introduzido por esta proposta.

**P1**
1. **Corrida `start` × `stop`**: se `start` for chamado concorrentemente ao drain, `stopped` volta a `false` e um tick pode iniciar com o tick antigo em voo (reusa a mesma promessa). Na prática `startServer` e `gracefulShutdown` não coexistem; documentado para testes de reinício.
2. **Tick pendurado após timeout**: `tickInFlight` permanece; um `start` posterior reusaria a promessa presa. Mitigado pelo `process.exit` do shutdown.
3. **`stopDotAgentWorker` (bare) não seta `stopped`** — intencional (compatível com o HEAD); quem precisa parar de verdade usa `stopDotAgentWorkerAndDrain`.

**P2**
4. Novos campos `in_flight`/`stopped` no payload de `/api/dot/status` — consumidores devem tolerar campos extras (já toleram, é JSON).
5. `runDotAgentWorkerTick` continua no código de produção (exportado) por causa do teste #143 — inalterado por decisão.

## 9. Diff completo (HEAD → proposta)

```diff
diff --git a/services/dotAgentWorker.ts b/review/dotAgentWorker.ledger.proposed.ts.txt
index 79dad4b..647ad22 100644
--- a/services/dotAgentWorker.ts
+++ b/review/dotAgentWorker.ledger.proposed.ts.txt
@@ -3,7 +3,21 @@ import { runCurrentDotMissionStep } from './dotAgentMissionRunner.js';
 
 let timer: NodeJS.Timeout | null = null;
 let running = false;
+/**
+ * A promessa do tick em andamento, UMA SÓ para todos os caminhos:
+ *
+ *  - tick de inicialização (`startDotAgentWorker`);
+ *  - tick de timer (`setInterval`);
+ *  - tick acordado (`wakeDotAgentWorker`);
+ *  - o encerramento gracioso (`stopDotAgentWorkerAndDrain`) aguarda esta
+ *    mesma promessa em vez de uma cópia desconectada do trabalho real.
+ *
+ * Sem o compartilhamento, um tick iniciado pelo timer não era observado pelo
+ * drain: o shutdown fechava o pool com a rodada ainda em voo.
+ */
 let tickInFlight: Promise<void> | null = null;
+/** Marcado pela parada: nenhum tick NOVO inicia até um novo `start`. */
+let stopped = false;
 
 async function runTick() {
   if (running) return;
@@ -50,25 +64,40 @@ export async function runDotAgentWorkerTick(task: () => Promise<void> = runTick)
   }
 }
 
+/**
+ * Porta ÚNICA de execução. Devolve a promessa JÁ em voo quando existir, de
+ * modo que inicialização, timer e `wakeDotAgentWorker` nunca iniciem dois
+ * ticks simultâneos. Nunca rejeita: `runDotAgentWorkerTick` contém o erro.
+ */
+function scheduleTick(): Promise<void> {
+  if (stopped) return Promise.resolve();
+  if (tickInFlight) return tickInFlight;
+  const promise = runDotAgentWorkerTick().finally(() => {
+    // Só limpa se ainda for esta promessa — um `stop`+`start` concorrente não
+    // pode zerar a referência de um tick diferente.
+    if (tickInFlight === promise) tickInFlight = null;
+  });
+  tickInFlight = promise;
+  return promise;
+}
+
 export function startDotAgentWorker() {
   if (process.env.DOT_AGENT_WORKER_ENABLED === '0') return;
   if (timer) return;
 
+  // Reinício após parada: libera a porta para os próximos ticks.
+  stopped = false;
   const intervalMs = Math.max(60_000, Number(process.env.DOT_AGENT_WORKER_INTERVAL_MS || 300_000));
 
-  void runDotAgentWorkerTick();
-  timer = setInterval(() => void runDotAgentWorkerTick(), intervalMs);
+  void scheduleTick();
+  timer = setInterval(() => void scheduleTick(), intervalMs);
   timer.unref();
   console.log(`🤖 DOT agente em background: intervalo ${Math.round(intervalMs / 60000)} min.`);
 }
 
 export function wakeDotAgentWorker() {
-  if (process.env.DOT_AGENT_WORKER_ENABLED === '0') return;
-  if (tickInFlight) return tickInFlight;
-  tickInFlight = runTick().finally(() => {
-    tickInFlight = null;
-  });
-  return tickInFlight;
+  if (process.env.DOT_AGENT_WORKER_ENABLED === '0') return undefined;
+  return scheduleTick();
 }
 
 /** Estado do worker para observabilidade em `/api/dot/status`. */
@@ -77,6 +106,8 @@ export function getDotAgentWorkerStatus() {
     disabled: process.env.DOT_AGENT_WORKER_ENABLED === '0',
     timer_active: Boolean(timer),
     running,
+    in_flight: Boolean(tickInFlight),
+    stopped,
     interval_ms: Math.max(60_000, Number(process.env.DOT_AGENT_WORKER_INTERVAL_MS || 300_000)),
   };
 }
@@ -86,3 +117,36 @@ export function stopDotAgentWorker() {
   clearInterval(timer);
   timer = null;
 }
+
+/**
+ * Para o worker e aguarda (limitado) o tick em andamento — qualquer um:
+ * o de inicialização, o de timer ou o acordado. O encerramento gracioso só
+ * fecha o pool depois desta promessa assentar.
+ *
+ * O worker avança etapas determinísticas dentro de transações e com lock
+ * durável; interromper um tick no meio deixa a missão em `working`, que o
+ * próximo boot retoma. Ainda assim, o encerramento gracioso tenta terminar o
+ * tick atual antes de fechar o pool do PostgreSQL — fechar o banco com uma
+ * consulta em voo é o caminho mais curto para os erros de reconexão vistos
+ * no Render.
+ *
+ * O worker NÃO toca o ledger do orçamento: reservas ambíguas do Dot
+ * (`dot_budget_reservations` com `sent_at`) são duráveis e só mudam por
+ * `finalize`/`reconcile` — o drain não as libera.
+ */
+export async function stopDotAgentWorkerAndDrain(timeoutMs = 5_000): Promise<{ drained: boolean; running: boolean }> {
+  stopped = true;
+  stopDotAgentWorker();
+  const inFlight = tickInFlight;
+  if (!inFlight) return { drained: true, running };
+  let timedOut = false;
+  const guard = new Promise<void>((resolve) => {
+    const t = setTimeout(() => {
+      timedOut = true;
+      resolve();
+    }, Math.max(0, timeoutMs));
+    if (typeof (t as any).unref === 'function') (t as any).unref();
+  });
+  await Promise.race([inFlight.catch(() => undefined), guard]);
+  return { drained: !timedOut, running };
+}

```
