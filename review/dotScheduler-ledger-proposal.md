# Filtra DOT — proposta de hand-merge de `services/dotScheduler.ts`

**Modo:** somente leitura. Nada aplicado. `services/dotScheduler.ts` **não** foi alterado.
**Repositório:** `C:\Users\lucas\backend-pr139-integration`
**Branch:** `reconcile/dot-production-2026-11-06`
**HEAD de referência:** `a907a345bd38523b1b984364235686f3641a7700`
**Fontes:** `stash@{0}` (rastreado) e `stash@{0}^3` (novos).

---

## 1. Artefatos

| Artefato | Caminho | Linhas | Bytes | MD5 | SHA-256 |
|---|---|---|---|---|---|
| Arquivo final proposto | `review/dotScheduler.ledger.proposed.ts.txt` | 270 | 11276 | `5731d461ee5ea80847ff5272267b23e3` | `1f4b2b6d4d452b383c9ccb0c0cc16e5fa3b454b82a5eb4f1e95c367cba3f4c48` |
| Diff HEAD → proposta | `review/dotScheduler.ledger.proposed.diff` | 93 | 3863 | `7ce20cc2b2dd53d63797ee25cd6d336c` | `e818f856ac2abf820e7ab9db7c3a2cbd8633d3d82c15b82e6e5e54e707e3de83` |

Diff: `1 file changed, 71 insertions(+), 4 deletions(-)`. CRLF para diff mínimo; `.txt` para não entrar no `tsconfig`.

## 2. Justificativa por alteração

| # | Alteração | Justificativa |
|---|---|---|
| 1 | `+ let currentRun: Promise<unknown> \| null` | referência única da rodada em voo; permite ao shutdown aguardá-la |
| 2 | `+ let stopped = false` | impede rodada NOVA após o início da parada; liberado no `start` |
| 3 | `startDotMonitorScheduler`: `stopped = false` | reinício explícito após parada |
| 4 | `startDotMonitorScheduler`: `tick()` único (`if (stopped \|\| currentRun) return`) | porta única: boot e timer compartilham a mesma rodada; elimina ticks simultâneos |
| 5 | `currentRun` guarda a promessa **completa** com `finally` que zera a referência | garante que, quando a promessa resolve, nenhuma consulta da rodada ainda pode ocorrer (corrige o bug `22 !== 21`) |
| 6 | `+ getDotSchedulerRuntimeStatus()` | observabilidade real: `timer_active`, `running`, `in_flight`, `stopped` |
| 7 | `+ stopDotMonitorScheduler(timeoutMs = 5_000)` | drena a rodada antes do `closeDB`; timeout com guarda `unref` |
| 8 | `stopDotMonitorScheduler` retorna `in_flight: timedOut ? Boolean(currentRun) : false` | **corrige** o retorno que reportava `in_flight: true` mesmo após drenar (exigência de `dotSchedulerDrain.test.ts`) e **não** reporta timeout como concluído |
| 9 | `runDueDotMonitors`/`runDueDotMonitorsUnlocked` **inalterados** | preservam lock durável, elegibilidade, idempotência e isolamento por empresa |
| 10 | SQL com planos anuais **inerente ao HEAD** | preserva o PR #141 |

## 3. Preservação do PR #141 (verificado)

A linha de SQL do HEAD — e da proposta — mantém os planos anuais:
```
AND LOWER(IFNULL(plan, '')) IN (
  'rei', 'rei-anual', 'corporativo', 'corporativo-anual',
  'corp', 'corp-anual', 'corporate', 'corporate-anual')
```
O `stash@{0}` tinha apenas `('rei', 'corporativo', 'corp', 'corporate')` (versão anterior). A proposta **não** regride: o diff do núcleo (`LOWER(IFNULL`, `runDotMonitor`, `monitorDueDotFollowUps`, `withDotLock`) está **vazio**.

## 4. Análise de concorrência e shutdown

Camadas de proteção (todas preservadas):
1. **`currentRun`** (novo) — porta única no nível do tick.
2. **`running`** (inalterado) — guarda dentro de `runDueDotMonitors`/`runDueDotMonitorsUnlocked`.
3. **`withDotLock('dot:scheduler', 10min, …, {waitMs:0})`** (inalterado) — lock **durável** entre instâncias; quem não obtém devolve `skipped`.
4. **Lock por empresa** em `runDotMonitor` (inalterado) — segunda linha de defesa.

| Cenário | Comportamento |
|---|---|
| `start` + tick imediato | `tick()` roda uma vez; `currentRun` fica setado |
| tick do timer durante rodada | `if (currentRun) return` → reutiliza |
| `start` + `start` | `if (timer) return` → um único timer |
| `stop` + `stop` | idempotente; segunda chamada devolve `{stopped:true, in_flight:false}` |
| `stop` + tick | `stopped` → nenhuma rodada nova |
| timeout no drain | `stopped:false`, `in_flight:true` (não é drenagem concluída) |
| sucesso no drain | `stopped:true`, `in_flight:false` |
| `stop` + `start` (reinício) | `start` zera `stopped` e cria novo timer; se a rodada antiga ainda estiver em voo (timeout), o próximo tick a reutiliza |

**Requisito 9/10:** o scheduler **não** fecha conexões nem toca o pool (usa `getDb()` só para ler/atualizar `empresas`), e **não** importa `dotLedger` — nenhum sweep/reconciliação ocorre no shutdown. Reservas ambíguas permanecem intactas.

## 5. Assinaturas reais exportadas (proposta)

```ts
export function getDotSchedulerStatus(): { ...DotSchedulerStatus; timer_active: boolean; tick_ms: number };
export async function runDueDotMonitors(): Promise<{ ok: boolean; skipped?: boolean; reason?: string; processed: number; results: any[]; followups: any[] }>;
export function startDotMonitorScheduler(): void;
export function getDotSchedulerRuntimeStatus(): { timer_active: boolean; running: boolean; in_flight: boolean; stopped: boolean };
export async function stopDotMonitorScheduler(timeoutMs = 5_000): Promise<{ stopped: boolean; in_flight: boolean }>;
```

## 6. Integração prevista com worker e servidor

**`server.ts`** (não alterado nesta etapa) precisará de:
| Import | Assinatura | Origem |
|---|---|---|
| `startDotMonitorScheduler` | `() => void` | HEAD + proposta |
| `stopDotMonitorScheduler` | `(ms=5000) => Promise<{stopped,in_flight}>` | **proposta** |
| `startDotAgentWorker` | `() => void` | HEAD |
| `stopDotAgentWorkerAndDrain` | `(ms=5000) => Promise<{drained,running}>` | `review/dotAgentWorker.ledger.proposed.ts.txt` |

Sequência de shutdown (`gracefulShutdown`): fechar HTTP → `await stopDotMonitorScheduler(5_000)` → `await stopDotAgentWorkerAndDrain(5_000)` → `await closeDB()`. A ordem entre scheduler e worker é livre; ambos só param trabalho próprio.

**Compatibilidade com o worker proposto:** os dois usam o mesmo padrão (`stopped` + promessa única + drain com guarda `unref` + `reportar timeout como não drenado`). A **corrida `start` × drain** identificada na proposta do worker vale igualmente aqui: `startDotMonitorScheduler` zera `stopped`; se chamado concorrentemente ao drain, pode criar um novo timer enquanto a rodada antiga ainda está em voo. No ciclo do servidor isso não ocorre (start só no boot, stop só no shutdown); fica registrado para testes de reinício.

## 7. Testes necessários

| Teste | O que cobre |
|---|---|
| `tests/dotSchedulerDrain.test.ts` (stash^3) | `in_flight` visível em voo; `false` após drenar; idempotência; `start` duplo não duplica timer (**define o retorno `in_flight:false` pós-drain usado na proposta**) |
| `tests/dotShutdown.test.ts` / `dotShutdownDrain.test.ts` (stash^3) | shutdown coordenado worker+scheduler |
| `tests/dotMonitorConcurrency.test.ts` (HEAD) | concorrência do monitor |
| `tests/dotMonitorResolve.test.ts` (HEAD) | resolução/elegibilidade |
| `tests/dot-plan-identification.test.ts` (HEAD) | planos anuais (#141) |

**Verificações somente leitura executadas:** sintaxe via `typescript.transpileModule` → **SINTAXE OK (271 linhas)**; SQL anual presente; núcleo sem alteração; exports conferidos. **Nenhum teste executado** (arquivo não aplicado).

## 8. Riscos e incompatibilidades pendentes

**P0** — nenhum novo.

**P1**
1. **Corrida `stop` (drain) × `start`**: `start` zera `stopped` e pode iniciar rodada com a anterior em voo (reutilizada no próximo tick). Só relevante em reinício no mesmo processo.
2. **Rodada em timeout**: `currentRun` permanece; `in_flight:true` e `stopped:false`. O `process.exit` do shutdown encerra; o próximo boot retoma (etapas idempotentes/transacionais).
3. **`withDotLock` com `waitMs:0`**: se outra instância detém o lock, a rodada é `skipped` — comportamento inalterado.

**P2**
4. `getDotSchedulerRuntimeStatus` tem campo novo `stopped` (JSON tolera campos extras).
5. `getDotSchedulerStatus` (usado no `/api/dot/status`) continua sem `in_flight`/`stopped`; se quiser expor, avaliar em rodada própria.

## 9. Diff completo (HEAD → proposta)

```diff
diff --git a/services/dotScheduler.ts b/review/dotScheduler.ledger.proposed.ts.txt
index 3fea550..6ba52d4 100644
--- a/services/dotScheduler.ts
+++ b/review/dotScheduler.ledger.proposed.ts.txt
@@ -41,6 +41,19 @@ const schedulerStatus: DotSchedulerStatus = {
 let timer: NodeJS.Timeout | null = null;
 let running = false;
 
+/**
+ * A rodada em andamento, quando existe.
+ *
+ * O agendador só usa `setInterval` (unref'd), mas uma rodada em curso mantém
+ * trabalho assíncrono vivo: sem referência, o encerramento gracioso do
+ * processo (SIGTERM do Render) poderia interromper uma rodada no meio de uma
+ * transação. `stopDotMonitorScheduler` permite aguardar a rodada terminar
+ * dentro do orçamento de shutdown.
+ */
+let currentRun: Promise<unknown> | null = null;
+/** Marcado pela parada: nenhuma rodada NOVA pode iniciar. */
+let stopped = false;
+
 function errorMessage(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
 }
@@ -194,10 +207,64 @@ export function startDotMonitorScheduler() {
     return;
   }
   const interval = Math.max(60_000, Number(process.env.FILTRA_DOT_MONITOR_TICK_MS || 300_000));
-  void runDueDotMonitors().catch((error) => console.warn('Dot scheduler startup:', errorMessage(error)));
-  timer = setInterval(() => {
-    void runDueDotMonitors().catch((error) => console.warn('Dot scheduler:', errorMessage(error)));
-  }, interval);
+  stopped = false;
+  const tick = () => {
+    // Uma única rodada por vez; o tick REUTILIZA a rodada em andamento em vez
+    // de enfileirar uma cópia imediata de `runDueDotMonitors()`.
+    if (stopped || currentRun) return;
+    // `currentRun` recebe a promessa COMPLETA, incluindo o bloco de limpeza —
+    // assim a parada só retorna quando NENHUMA consulta da rodada pode mais
+    // acontecer. Cada etapa interna é idempotente e transacional.
+    const run = (async () => {
+      try {
+        await runDueDotMonitors();
+      } catch (error) {
+        console.warn('Dot scheduler:', errorMessage(error));
+      } finally {
+        if (currentRun === run) currentRun = null;
+      }
+    })();
+    currentRun = run;
+  };
+  tick();
+  timer = setInterval(tick, interval);
   timer.unref();
   console.log(`Filtra Dot monitor ativo — tick ${Math.round(interval / 1000)}s`);
 }
+
+/** Estado para `/api/dot/status` (observabilidade do agendador). */
+export function getDotSchedulerRuntimeStatus() {
+  return { timer_active: Boolean(timer), running, in_flight: Boolean(currentRun), stopped };
+}
+
+/**
+ * Para o agendador e aguarda (limitado) a rodada em andamento.
+ *
+ * Nunca espera indefinidamente — a rodada que não terminar dentro de
+ * `timeoutMs` é interrompida pelo `process.exit` do shutdown, e nada é
+ * corrompido porque cada etapa é idempotente e transacional.
+ *
+ * Não fecha conexões nem toca o pool do banco, e não executa sweep nem
+ * reconciliação do ledger: reservas ambíguas do Dot permanecem intactas.
+ */
+export async function stopDotMonitorScheduler(timeoutMs = 5_000): Promise<{ stopped: boolean; in_flight: boolean }> {
+  stopped = true;
+  if (timer) {
+    clearInterval(timer);
+    timer = null;
+  }
+  const inFlight = currentRun;
+  if (!inFlight) return { stopped: true, in_flight: false };
+  let timedOut = false;
+  const guard = new Promise<void>((resolve) => {
+    const t = setTimeout(() => {
+      timedOut = true;
+      resolve();
+    }, Math.max(0, timeoutMs));
+    if (typeof (t as any).unref === 'function') (t as any).unref();
+  });
+  await Promise.race([inFlight.catch(() => undefined), guard]);
+  // Sucesso: o `finally` da rodada já zerou `currentRun` -> nada em voo.
+  // Timeout: a rodada continua e NÃO pode ser reportada como drenada.
+  return { stopped: !timedOut, in_flight: timedOut ? Boolean(currentRun) : false };
+}

```
