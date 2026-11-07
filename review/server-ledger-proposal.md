# Filtra DOT — proposta de hand-merge de `server.ts`

**Modo:** somente leitura. Nada aplicado. `server.ts` **não** foi alterado.
**Repositório:** `C:\Users\lucas\backend-pr139-integration`
**Branch:** `reconcile/dot-production-2026-11-06`
**HEAD de referência:** `a907a345bd38523b1b984364235686f3641a7700`
**Fontes:** `stash@{0}` (rastreado) e `stash@{0}^3` (novos).

---

## 1. Artefatos

| Artefato | Caminho | Linhas | Bytes | MD5 | SHA-256 |
|---|---|---|---|---|---|
| Arquivo final proposto | `review/server.ledger.proposed.ts.txt` | 544 | 21957 | `76ee37ff4c900ac4d79d1feb996554fc` | `90849d158f0e586f67589956eecdb037ebd82b009cf7b66fedf2a171206a84b9` |
| Diff HEAD → proposta | `review/server.ledger.proposed.diff` | 184 | 9019 | `09a0adcfb23b49af64b49a4c64446aba` | `382ea639c65cdd53956d30c8b880e644508e686bf89a71c9eba1e126385c1740` |

Diff: `1 file changed, 86 insertions(+), 16 deletions(-)`. CRLF + `.txt` (fora do `tsconfig`).

O HEAD de `server.ts` é **idêntico** a `510ddc0`, então o delta do ledger se aplica limpo; a proposta **parte do delta do stash** e o melhora (drain com resultado real + gate fail-closed).

## 2. Justificativa por alteração

| # | Alteração | Justificativa |
|---|---|---|
| R1 | imports `stopDotMonitorScheduler`, `stopDotAgentWorkerAndDrain`, `stopMonthlyReportScheduler`, `assertDotLedgerSchema` | o shutdown drena DOT e o boot valida o ledger |
| R2/R3 | imports `stopRetryWorker`, `stopAcquisitionWorker`, `stopAcquisitionReplenisher` | parada de timers no shutdown |
| R4 | `backgroundStops` (tipo `stop: () => unknown`) + `dotLedgerReady` | **só timers síncronos**; o DOT fica de fora (evita parada duplicada) |
| R5 | `trackBackground('retry worker', …)` | para o timer de retry |
| R6 | `trackBackground('acquisition worker'/'acquisition replenisher')` + `replenisherBoot` cancelável | evita boot tardio do replenisher após `closeDB` |
| R7 | `assertDotLedgerSchema()` em try/catch dedicado → `dotLedgerReady` | **validação** do schema criado pela migração central; sem segunda fonte de DDL e sem DDL por requisição |
| R8 | gate `if (dotRuntimeEnabled()) { if (!dotLedgerReady) → 503 … }` | **fail-closed**: ledger inválido não ativa o DOT; o resto do servidor segue |
| R9 | `trackBackground('monthly report scheduler', …)` | para o scheduler do relatório mensal |
| R10 | `gracefulShutdown` reescrito | sequência explícita + log de drenagem/timeout + `closeDB()` único |

## 3. Fluxo de inicialização (ordem preservada)

1. `server = app.listen(PORT, '0.0.0.0')` — liveness HTTP imediata (inalterado).
2. `RUN_SUPABASE_MIGRATION` (se ligado) → `await initDB()`.
3. `initDB()` → `runCentralMigrations` — **fonte única** de DDL, inclui `dot_budget_reservations`.
4. `ensure*Schema` (unidades, webauthn, push, ai_usage, ops, audit, fiscal, plan pricing, followup, acquisition, treatment, dot access/agent/missions) — inalterado.
5. **`await assertDotLedgerSchema()` → `dotLedgerReady = true`** (validação, sem DDL).
6. Workers: `startRetryWorker` / `startAcquisitionWorker` (+ `startAcquisitionReplenisher` em 60 s) / Product Hunt / HubSpot — com `trackBackground`.
7. `ensureEmpresaOwnerSchema` / `ensureDotAdminSecuritySchema`.
8. Backfill de sentimento / LGPD sweep.
9. `mount*Routes` (inalterado).
10. **Ativação do DOT**: `dotRuntimeEnabled() && dotLedgerReady` → monta rotas + `startDotMonitorScheduler()` + `startDotAgentWorker()`. Senão, `503`/tombstone e **nada de DOT ligado**.
11. `startMonthlyReportScheduler()` + `trackBackground`.
12. Login admin, reset, MFA, Stripe, `notFoundHandler`/`errorHandler`.

## 4. Sequência de shutdown

```
SIGTERM/SIGINT
└─ gracefulShutdown(signal)
   1. if (shuttingDown) return; shuttingDown = true   (idempotente/reentrante)
   2. force = setTimeout(25s)                          (global, unref)
   3. server.close()                                   (para HTTP)
   4. backgroundStops.reverse(): stop()                (timers síncronos + log)
        retry worker · acquisition worker · acquisition replenisher (+clearTimeout) · monthly report scheduler
   5. drain('DOT scheduler',       stopDotMonitorScheduler(5_000))     -> {stopped, in_flight}
   6. drain('DOT agent worker',    stopDotAgentWorkerAndDrain(5_000))  -> {drained, running}
   7. await closeDB()                                  (UMA única vez)
   8. log final + process.exit(0)
```

## 5. Componentes × função de parada × retorno × drenagem

| Componente | Função | Retorno | Aguarda execução em voo? |
|---|---|---|---|
| retry worker | `stopRetryWorker()` | `void` | ❌ (só timer) |
| acquisition worker | `stopAcquisitionWorker()` | `void` | ❌ (só timer) |
| acquisition replenisher (+ boot 60s) | `clearTimeout(replenisherBoot); stopAcquisitionReplenisher()` | `boolean` | ❌ (só timer/boot) |
| monthly report scheduler | `stopMonthlyReportScheduler()` | `void` | ❌ (só timer) |
| **DOT scheduler** | `stopDotMonitorScheduler(5_000)` | `{ stopped: boolean; in_flight: boolean }` | ✅ |
| **DOT agent worker** | `stopDotAgentWorkerAndDrain(5_000)` | `{ drained: boolean; running: boolean }` | ✅ |

**Distinção explícita** (exigida): `stop*` de timer **não** significa drenagem. Só scheduler/worker devolvem se ainda há trabalho em voo; o log registra o JSON do retorno (`in_flight`/`drained`) — timeout ⇒ `stopped:false`/`drained:false`.

## 6. Idempotência, timeout e `closeDB`

- **Reentrância:** `shuttingDown` (inalterado) impede segunda execução → `closeDB()` chamado **uma vez**.
- **Timeout individual:** 5 s por drain DOT; **timeout global:** `force` de 25 s (inalterado). 5+5 s < 25 s.
- **Timeout → não drenado:** o resultado (`stopped:false` / `drained:false`) é logado; **`closeDB()` ainda roda** e o risco de operação pendente fica explícito no log final.
- **Falha intermediária:** cada `stop`/`drain` tem try/catch; uma falha não impede os demais nem o fechamento.
- **`backgroundStops`:** necessário para os timers síncronos; **não** inclui DOT (senão haveria parada duplicada). O `stash` registrava o DOT nos dois lugares — a proposta corrige.

## 7. Preservações e não-alterações

- Rotas, middlewares, CORS, `notFoundHandler`/`errorHandler`: **inalterados** (diff só toca imports, shutdown e boot).
- **#141/#142/#143**: `server.ts` não toca `lib/plans.ts`, `lib/cors.ts` nem os workers; o SQL de planos anuais vive no scheduler (preservado na proposta dele).
- **Execution gateway / aprovação / autorização**: nenhum hunk em `/actions/*`, permissões ou `X-Dot-Admin`.
- **Sem fallback Rei**: nenhuma alteração de plano em `server.ts`.
- **Ledger no shutdown**: a drenagem não executa `sweep` nem reconciliação — **reservas ambíguas (`sent_at`) permanecem intactas**.

## 8. Decisão pendente (explícita)

`assertDotLedgerSchema()` valida o schema criado pela **migração central** (sem DDL no server). O `stash` usava `ensureDotLedgerSchema()` (DDL idempotente no boot). Escolhi a validação para atender “não criar segunda fonte de migração”; **alternativa** (mais resiliente, menos estrita): trocar por `ensureDotLedgerSchema()` mantendo `dotLedgerReady`. Recomenda-se decidir junto da integração de `lib/migrations.ts`.

## 9. Testes necessários

| Teste | Cobre |
|---|---|
| `tests/dotShutdown.test.ts` / `dotShutdownDrain.test.ts` (stash^3) | shutdown coordenado worker+scheduler; `in_flight`/drain |
| `tests/workerSchemaBootstrap.test.ts` (#143) | bootstrap de schema dos workers intacto |
| `tests/dotSchedulerDrain.test.ts` (stash^3) | drenagem do scheduler |
| `tests/dot-plan-identification.test.ts` (#141) | planos anuais |
| `tests/cors-allowlist.test.ts` (#142) | CORS |
| smoke de boot (`/api/health`, `/api/dot/status`) | gate fail-closed e tombstone |

**Verificações somente leitura:** sintaxe via `typescript.transpileModule` → **SINTAXE OK (545 linhas)**; presença de todos os `stop*`; `await closeDB` **1×**; `backgroundStops` sem DOT; gate fail-closed presente. **Nenhum teste executado** (arquivo não aplicado).

## 10. Riscos e decisões pendentes

**P0**
1. Se `services/dotLedger.ts` não for integrado, `server.ts` **não compila** (`assertDotLedgerSchema`). Dependência obrigatória.
2. Se a migração central do ledger não rodar, `assertDotLedgerSchema` falha → DOT desativado (fail-closed). É o comportamento desejado; documentar no runbook.

**P1**
3. retry/acquisition/replenisher/monthly report **não têm drain** — a parada é só de timer; um tick em voo pode tocar o banco durante/às vezes depois de `closeDB`. Aceitável hoje (ticks curtos), mas registrar.
4. Timeout do DOT: `closeDB()` roda com a rodada possivelmente viva (risco logado). O `process.exit` encerra; etapas são idempotentes/transacionais.

**P2**
5. `backgroundStops` no `server.ts` introduz estado global; manter apenas para timers sync.
6. Ordem scheduler→worker é arbitrária (não há dependência entre eles); mantida por simetria.

## 11. Diff completo (HEAD → proposta)

```diff
diff --git a/server.ts b/review/server.ledger.proposed.ts.txt
index 8b3809a..54f90d6 100644
--- a/server.ts
+++ b/review/server.ledger.proposed.ts.txt
@@ -62,9 +62,10 @@ import { ensureDotAdminSecuritySchema } from './services/dotAdminSecurity.js';
 import { ensureDotAccessSchema } from './services/dotAccessControl.js';
 import { ensureDotAgentSchema } from './services/dotAgent.js';
 import { ensureMissionTables } from './services/dotAgentMissions.js';
-import { startDotMonitorScheduler } from './services/dotScheduler.js';
-import { startMonthlyReportScheduler, getMonthlyReportSchedulerStatus } from './services/monthlyReportScheduler.js';
-import { startDotAgentWorker } from './services/dotAgentWorker.js';
+import { startDotMonitorScheduler, stopDotMonitorScheduler } from './services/dotScheduler.js';
+import { startMonthlyReportScheduler, getMonthlyReportSchedulerStatus, stopMonthlyReportScheduler } from './services/monthlyReportScheduler.js';
+import { startDotAgentWorker, stopDotAgentWorkerAndDrain } from './services/dotAgentWorker.js';
+import { assertDotLedgerSchema } from './services/dotLedger.js';
 import { mcpApp } from './filtraMcp.js';
 import { stripeConfigured, refreshPlanPricesFromDb } from './stripeBilling.js';
 import { paypalConfigured } from './lib/paypal.js';
@@ -77,14 +78,14 @@ import { ensurePushSchema, pushConfigured, initWebPush } from './lib/push.js';
 import { ensureAiUsageSchema } from './lib/aiUsage.js';
 import { ensureOpsTables } from './lib/opsLog.js';
 import { ensureAuditSchema } from './lib/auditLog.js';
-import { ensureRetryQueue, startRetryWorker } from './lib/retryQueue.js';
+import { ensureRetryQueue, startRetryWorker, stopRetryWorker } from './lib/retryQueue.js';
 import { registerAllRetryHandlers } from './lib/retryHandlers.js';
 import { ensurePlanPricingSchema } from './lib/planPricing.js';
 import { allowPlanSwitch } from './lib/plans.js';
 import { smtpConfigured } from './lib/mailer.js';
 import { n8nConfigured } from './lib/n8n.js';
-import { ensureAcquisitionEngineSchema, startAcquisitionWorker } from './lib/acquisitionEngine.js';
-import { startAcquisitionReplenisher } from './lib/acquisitionReplenisher.js';
+import { ensureAcquisitionEngineSchema, startAcquisitionWorker, stopAcquisitionWorker } from './lib/acquisitionEngine.js';
+import { startAcquisitionReplenisher, stopAcquisitionReplenisher } from './lib/acquisitionReplenisher.js';
 import { startProductHuntAcquisition } from './lib/acquisitionProductHunt.js';
 import { startHubSpotAcquisitionSync } from './lib/hubspotAcquisitionSync.js';
 import { ensureFiscalSchema, fiscalConfigured } from './lib/fiscal.js';
@@ -224,6 +225,20 @@ app.get('/api/metrics', (req, res) => {
 const PORT = Number(process.env.PORT || 5000);
 let server: Server | null = null;
 let shuttingDown = false;
+/** `true` só depois de VALIDAR o schema do ledger criado pela migração central. */
+let dotLedgerReady = false;
+
+/**
+ * Componentes de background com parada SÍNCRONA (timer). O DOT NÃO entra aqui:
+ * usa drains assíncronos próprios (`stopDotMonitorScheduler`/
+ * `stopDotAgentWorkerAndDrain`), que aguardam a execução em voo. Registrar o
+ * DOT aqui criaria parada DUPLICADA.
+ */
+const backgroundStops: Array<{ name: string; stop: () => unknown }> = [];
+
+function trackBackground(name: string, stop: () => unknown): void {
+  backgroundStops.push({ name, stop });
+}
 
 
 
@@ -266,12 +281,42 @@ async function gracefulShutdown(signal: string) {
   force.unref();
 
   try {
+    // 1) Para de aceitar novas requisições HTTP (o processo segue vivo).
     if (server) {
       await new Promise<void>((resolve) => server!.close(() => resolve()));
       console.log('HTTP fechado.');
     }
+
+    // 2) Timers dos subsistemas com parada SÍNCRONA. Aqui `stop` significa
+    //    "parar o timer" — nada em voo é aguardado neste grupo.
+    for (const entry of backgroundStops.slice().reverse()) {
+      try {
+        const result = entry.stop();
+        console.log(`[shutdown] ${entry.name}: timer parado`, result === undefined ? '' : JSON.stringify(result));
+      } catch (e: any) {
+        console.warn(`[shutdown] falha ao parar ${entry.name}:`, e?.message || e);
+      }
+    }
+
+    // 3) Drena o DOT: aguarda a execução em voo (scheduler e worker) dentro do
+    //    teto individual. O retorno distingue drenagem concluída de timeout.
+    const drain = async <T>(label: string, stop: () => Promise<T>): Promise<T | null> => {
+      try {
+        const result = await stop();
+        console.log(`[shutdown] ${label}:`, JSON.stringify(result));
+        return result;
+      } catch (e: any) {
+        console.warn(`[shutdown] falha ao drenar ${label}:`, e?.message || e);
+        return null;
+      }
+    };
+    const dotScheduler = await drain('DOT scheduler', () => stopDotMonitorScheduler(5_000));
+    const dotWorker = await drain('DOT agent worker', () => stopDotAgentWorkerAndDrain(5_000));
+
+    // 4) Fecha o pool UMA única vez, após as drenagens. Se algum drain expirou,
+    //    o risco de operação pendente fica explícito no log abaixo.
     await closeDB();
-    console.log('Banco fechado.');
+    console.log('Banco fechado.', { dot_scheduler: dotScheduler, dot_agent_worker: dotWorker });
     clearTimeout(force);
     process.exit(0);
   } catch (e: any) {
@@ -354,19 +399,27 @@ export async function startServer() {
     await ensureRetryQueue(getDb());
     registerAllRetryHandlers();
     startRetryWorker();
+    trackBackground('retry worker', stopRetryWorker);
   } catch (e) {
     console.warn('retry queue:', e);
   }
   try {
     await ensureAcquisitionEngineSchema(getDb());
     startAcquisitionWorker();
-    setTimeout(() => {
+    trackBackground('acquisition worker', stopAcquisitionWorker);
+    // O bootstrap atrasado do replenisher também é cancelado no encerramento:
+    // sem isso ele podia nascer DEPOIS do fechamento do pool do PostgreSQL.
+    const replenisherBoot = setTimeout(() => {
       try {
         startAcquisitionReplenisher();
       } catch (e: any) {
         console.warn('[acquisition-replenisher] delayed bootstrap failed:', e?.message || e);
       }
     }, 60_000);
+    trackBackground('acquisition replenisher', () => {
+      clearTimeout(replenisherBoot);
+      return stopAcquisitionReplenisher();
+    });
     await startProductHuntAcquisition();
     await startHubSpotAcquisitionSync();
   } catch (e) {
@@ -384,6 +437,15 @@ export async function startServer() {
   } catch (e) {
     console.warn('dot schema:', e);
   }
+  try {
+    // A tabela `dot_budget_reservations` e as colunas de token são criadas pela
+    // migração central (`initDB`). Aqui só VALIDAMOS: sem segunda fonte de DDL
+    // e sem DDL por requisição. Falha aqui mantém o DOT desativado (fail-closed).
+    await assertDotLedgerSchema();
+    dotLedgerReady = true;
+  } catch (e) {
+    console.warn('dot ledger schema:', e);
+  }
   try {
     await ensureEmpresaOwnerSchema(getDb());
     await ensureDotAdminSecuritySchema();
@@ -427,14 +489,21 @@ export async function startServer() {
   mountTelegramRoutes(app);
   mountFiscalRoutes(app);
   if (dotRuntimeEnabled()) {
-    mountDotRoutes(app);
-    mountDotAccessRoutes(app);
-    mountDotAgentRoutes(app);
-    mountDotAgentMissionRoutes(app);
-    mountDotAdminRoutes(app);
-    startDotMonitorScheduler();
-    startDotAgentWorker();
-    console.log('[dot] Filtra Dot habilitado: rotas + monitor + agente em background.');
+    if (!dotLedgerReady) {
+      // Fail-closed: sem schema de orçamento validado, o DOT não é ativado; o
+      // restante do servidor segue funcionando normalmente.
+      app.get('/api/dot/status', (_req, res) => res.status(503).json({ ok: false, enabled: false, access: false, error: 'Filtra Dot indisponível: schema do orçamento não validado.' }));
+      console.error('[dot] ledger schema inválido — Filtra Dot NÃO ativado (fail-closed).');
+    } else {
+      mountDotRoutes(app);
+      mountDotAccessRoutes(app);
+      mountDotAgentRoutes(app);
+      mountDotAgentMissionRoutes(app);
+      mountDotAdminRoutes(app);
+      startDotMonitorScheduler();
+      startDotAgentWorker();
+      console.log('[dot] Filtra Dot habilitado: rotas + monitor + agente em background.');
+    }
   } else {
     app.get('/api/dot/status', (_req, res) => res.status(403).json({ ok: false, enabled: false, access: false, error: 'Filtra Dot desativado. Defina FILTRA_DOT_ENABLED=1 para habilitar.' }));
     console.log('[dot] Filtra Dot desativado (defina FILTRA_DOT_ENABLED=1 para habilitar).');
@@ -442,6 +511,7 @@ export async function startServer() {
 
   // Agendador in-process do relatório mensal (sem cron externo e sem credenciais).
   startMonthlyReportScheduler();
+  trackBackground('monthly report scheduler', stopMonthlyReportScheduler);
 
   mountAdminLoginRoute(app, getDb, { setAuthCookie, JWT_SECRET });
   mountAdminPasswordResetRoutes(app, getDb);

```
