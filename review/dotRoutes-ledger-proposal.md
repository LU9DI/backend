# Filtra DOT — proposta de `routes/dotRoutes.ts` (integração seletiva do ledger)

**Modo:** somente leitura. Nada aplicado. `routes/dotRoutes.ts` **não** foi alterado.
**Repositório:** `C:\Users\lucas\backend-pr139-integration`
**Branch:** `reconcile/dot-production-2026-11-06`
**HEAD de referência:** `a907a345bd38523b1b984364235686f3641a7700`
**Fontes:** `stash@{0}` (rastreado) e `stash@{0}^3` (novos).

---

## 1. Artefatos desta revisão

| Artefato | Caminho | Linhas | MD5 | SHA-256 |
|---|---|---|---|---|
| Arquivo final proposto | `review/dotRoutes.ledger.proposed.ts.txt` | 1046 | `77bea7b4acaf8b3cb1babb0c42f2e253` | `9a9170cc96421b9a16174f40119ddf4f7ba9f079527a6969a031069db1301e36` |
| Diff HEAD → proposta | `review/dotRoutes.ledger.proposed.diff` | 676 | `d880ce1edff79a4e847397f6e8d7fa59` | `2819156091f2d7b492a40e727c67d4cbaae77150287c3e80a582d0bbbdf89554` |

O arquivo proposto foi gerado por script a partir do HEAD real (não é cópia manual) e reemitido em **CRLF** para produzir diff mínimo. É um `.txt` de propósito, para **não** ser capturado por `tsconfig` (`**/*.ts`) e não quebrar `npm run build`.

## 2. Resumo do diff

```
1 arquivo alterado, 277 inserções(+), 217 remoções(-)
```

Mudanças por área:
- **imports**: entra o `services/dotLedger.js` (+ `dotResponseTokenLimit`) e `services/dotProviderOutcome.js`; sai `getFeatureTokenLimit`/`tokensUsadosFeatureMes`.
- **orçamento em memória** (linhas 77–224 do HEAD): removido e substituído por adaptadores sobre o ledger.
- **`resolveDotAccess`**: mantém `normalizePlan`/`planIdentified` e ganha o gancho `filtra.test.auth` **restrito a `NODE_ENV === 'test'`**.
- **`settleDotCallFailure`**: nova regra única de liquidação de falha.
- **`/api/dot/budget`**: novo endpoint.
- **`/explain`** e **`/chat`**: reescritos para o ledger (reserva → envio marcado → finalização com consumo real; ambíguo mantém reserva).
- **respostas**: removido `plan: access.plan || 'rei'` / `plan_label: access.planLabel || 'Rei'` em briefing, action/prepare e chat.

## 3. Justificativa de cada alteração

| # | Local (HEAD) | Alteração | Justificativa |
|---|---|---|---|
| 1 | `dotRoutes.ts:17-18` | imports do ledger/providerOutcome; remove `getFeatureTokenLimit`/`tokensUsadosFeatureMes` | os símbolos antigos só existiam para o orçamento em memória; o novo orçamento vem do ledger |
| 2 | `:77-224` | remove `DOT_RESPONSE_TOKEN_LIMITS`, `DOT_TOKEN_RESERVATION_TTL_MS`, `dotTokenReservations`, `cleanup*`, `dotResponseTokenLimit` (local), `checkDotTokenBudget`, `DOT_TOKEN_WARNING_THRESHOLD`, `releaseDotTokenReservation` | a reserva em memória não sobrevive a restart nem é vista por outra instância; o ledger é a fonte única |
| 3 | `:83-89` (novo) | `dotPlanKey` mantém `normalizePlan` e retorna `null` para plano não identificado | preserva o #141 (fail-closed por plano); sem fallback Rei |
| 4 | `:77` (novo) | `dotFeatureTokenSnapshot`/`getDotTokenUsage` passam a ler `getDotBudgetSnapshot` | painel/status usam a mesma fonte do ledger |
| 5 | `:299-311` | `resolveDotAccess` + `routesApp` | permite os testes HTTP do ledger sem JWT real, **sem** expor o gancho em produção |
| 6 | `:346` (novo) | `settleDotCallFailure` | regra única: libera só com prova de não envio; ambíguo mantém reserva |
| 7 | `:407` (novo) | `GET /api/dot/budget` | visão operacional do orçamento (consumo real + reservas abertas/ambíguas), sem dado sensível |
| 8 | `:726-768` | `/explain` sob ledger, com `companyId`/demo e `skipUsageRecord` | evita dupla contabilização e cobre explain pelo orçamento |
| 9 | `:769-986` | `/chat` sob ledger, com `companyId`/demo | mesma regra; demo não reserva |
| 10 | respostas | remove `\|\| 'rei'`/`\|\| 'Rei'` | plano não identificado nunca é exibido como Rei |
| 11 | `:355` | `routesApp = app` no `mountDotRoutes` | liga o gancho de teste |

## 4. Gancho `filtra.test.auth` — pode ser eliminado?

**Verificação:** sim, é eliminável; **não** é indispensável.

- Os dois testes que o usam (`tests/dotChatLedger.http.test.ts`, `tests/dotExplainLedger.http.test.ts`) montam `app.set('filtra.test.auth', …)`.
- `tests/dotAdminBudget.http.test.ts` (mesmo ciclo) prova que dá para usar **JWT real**: assina com `lib/jwtKeys.signAccessToken`, semeia `empresas`/`usuarios`/`empresa_owners` e envia `Authorization: Bearer`.
- Migração dos dois testes: (a) semear empresa + usuário + proprietário; (b) `token = signAccessToken({...})`; (c) enviar `Authorization`; (d) remover `app.set('filtra.test.auth', …)`.
- **Decisão nesta proposta:** manter o gancho, **restrito** a `process.env.NODE_ENV === 'test'` (defesa em profundidade — em produção `routesApp` é inerte). A remoção total fica como follow-up de teste, não como requisito de integração. Assim os testes atuais continuam válidos sem reescrita.

## 5. Dependências e incompatibilidades

**Depende de (ordem de integração):**
1. `services/dotProviderOutcome.ts` (novo) — `classifyDotProviderError`, `isProvenNotSent`, `describeDotProviderOutcome`.
2. `services/dotLedger.ts` (novo) — `reserveDotExecution`, `markDotReservationSent`, `finalizeDotReservation`, `releaseDotReservation`, `getDotBudgetSnapshot`, `listOpenDotReservations`, `dotResponseTokenLimit`, `DOT_FEATURE`, `buildDotBudgetAlert`, `emitDotBudgetAlert`, `type DotReservation`.
3. `groqService.ts` — `skipUsageRecord` e `input_tokens`/`output_tokens` no retorno (a proposta passa `skipUsageRecord: true`).
4. `lib/migrations.ts` — tabela `dot_budget_reservations` + `sent_at` + `ai_usage.tokens_input/output`.

**Incompatibilidades encontradas:**
- `HEAD` exporta `runDotAgentWorkerTick` (usado por `tests/workerSchemaBootstrap.test.ts`): **não afeta** este arquivo, mas é restrição do hand-merge do worker (§B, arquivo separado).
- `services/dotLedger.ts` usa `normalizePlanAlias` internamente — **requer adaptação** para `normalizePlan` (fora deste arquivo).
- Sem os arquivos 1–4, a proposta **não compila** (imports ausentes) — é esperado; a integração é faseada.

## 6. Testes associados a cada fluxo

| Fluxo | Teste |
|---|---|
| `dotPlanKey`/`planIdentified`/hook | `tests/dot-plan-identification.test.ts`, `dotChatLedger.http.test.ts`, `dotExplainLedger.http.test.ts` |
| Reserva/finalização/ambiguidade | `tests/dotLedger.test.ts`, `dotSentReservation.test.ts`, `dotProviderOutcome.test.ts` |
| `/chat` (demo + ledger) | `tests/dotChatLedger.http.test.ts`, `aiUsageDedup.test.ts` |
| `/explain` | `tests/dotExplainLedger.http.test.ts` |
| `/api/dot/budget` | `tests/dotChatLedger.http.test.ts` (GET público), `dotAdminBudget.http.test.ts` (variante admin) |
| Isolamento/segurança | `tests/dotRouteProtection.test.ts`, `dot-security-hardening.test.ts`, `dotEmpresaOwner.test.ts` |
| Migração legada (tokens/sent_at) | `tests/dotMigrationLegacy.test.ts` |
| PG real | `tests/dotLedger.pg.test.ts`, `dotExecutionAtomicity.pg.test.ts`, `pgTestUtilsSafety.test.ts` |

## 7. Riscos não resolvidos

**P0**
1. Dupla contabilização se `groqService` não respeitar `skipUsageRecord` (fora deste arquivo) — mitigar com `tests/aiUsageDedup.test.ts`.
2. Ledger não trata plano não identificado se `dotPlanKey` for alterado — o arquivo mantém `null`; revisar em regressão (`dot-plan-identification`).
3. Migração em duas fontes (`ensureDotLedgerSchema` runtime + central) — decidir a central como autoridade.

**P1**
4. Gancho de teste permanece no código de produção (restrito a `NODE_ENV=test`) — follow-up de migração para JWT real.
5. `getTokenLimit(access.plan)` exige plano identificado; para demo/não identificado o campo `feedback_token_limit` vira `null` (mudança de forma de resposta aceitável, mas a confirmar com o frontend).
6. `dotResponseTokenLimit(access.plan)` em demo usa o limite do plano; sem plano identificado retorna 0 — demo com `filtra.test.auth` sem plano válido reduziria o teto; nos testes o plano é `rei`.
7. Ordem de integração: sem itens 1–4, `dotRoutes.ts` não compila.

**P2**
8. `token_scope` agora é sempre `DOT_FEATURE` (`'dot'`); confirmar consumidores.
9. Comentários/doc do arquivo mencionam `X-Dot-Csrf` e `X-Dot-Admin`; preservados.

## 8. Verificação explícita de ausência de fallback `rei`

Comando aplicado ao arquivo proposto:
```
grep -nE "\|\| 'rei'|\|\| 'Rei'" review/dotRoutes.ledger.proposed.ts.txt   →  NENHUM resultado
```
- `dotPlanKey` retorna `null` quando `normalizePlan(plan)` não é `rei`/`corporativo`.
- Todas as respostas usam `access.plan ?? null` / `access.planLabel ?? null`.
- `getTokenLimit` só é chamado se `access.plan` existir (`access.plan ? getTokenLimit(access.plan) : null`).
- Nenhuma rota autoriza por fallback: o gate `resolveDotGate` (#141) continua sendo a única porta.

## 9. Preservações confirmadas no arquivo proposto

| Item | Ocorrências / verificação |
|---|---|
| `normalizePlan` | 6 |
| `planIdentified` | 4 |
| CSRF `X-Dot-Csrf` | 1 |
| `requireMutationPermission` | 11 |
| `requireDotAdminSession` | 2 (execução de ação — sem alteração) |
| Execution gateway / separação de aprovação | intactos (diff não toca `/actions/:id/*`) |
| `checkDotTokenBudget`/`dotTokenReservations`/`releaseDotTokenReservation` | **0** (removidos) |
| `getFeatureTokenLimit`/`tokensUsadosFeatureMes` | **0** (removidos) |

## 10. Diff completo (HEAD → proposta)

```diff
diff --git a/routes/dotRoutes.ts b/review/dotRoutes.ledger.proposed.ts.txt
index 89593ef..9628fb7 100644
--- a/routes/dotRoutes.ts
+++ b/review/dotRoutes.ledger.proposed.ts.txt
@@ -18,7 +18,21 @@ import { planLabel, normalizePlan } from '../lib/plans.js';
 import { resolveDotGate } from '../services/dotAccessGate.js';
 import { getDotSchedulerStatus } from '../services/dotScheduler.js';
 import { getDotAgentWorkerStatus } from '../services/dotAgentWorker.js';
-import { getTokenLimit, getFeatureTokenLimit, tokensUsadosFeatureMes } from '../lib/quota.js';
+import { getTokenLimit } from '../lib/quota.js';
+import {
+  DOT_FEATURE,
+  buildDotBudgetAlert,
+  dotResponseTokenLimit,
+  emitDotBudgetAlert,
+  finalizeDotReservation,
+  getDotBudgetSnapshot,
+  listOpenDotReservations,
+  markDotReservationSent,
+  releaseDotReservation,
+  reserveDotExecution,
+  type DotReservation,
+} from '../services/dotLedger.js';
+import { classifyDotProviderError, describeDotProviderOutcome, isProvenNotSent } from '../services/dotProviderOutcome.js';
 import { selectDotModel } from '../services/dotModelRouting.js';
 import { requireDotAccess, type DotAccessResource, type DotAccessAction } from '../services/dotAccessControl.js';
 
@@ -68,162 +82,37 @@ type DotAccess = {
 const sessions = new Map<string, ChatItem[]>();
 const MAX_HISTORY = 12;
 
-const DOT_RESPONSE_TOKEN_LIMITS: Record<string, number> = {
-  // REI é o plano de maior profundidade de inteligência.
-  // Corporativo privilegia escala/governança, sem superar o REI em profundidade por resposta.
-  rei: Math.max(300, Number(process.env.DOT_REI_RESPONSE_TOKENS || 1800)),
-  corporativo: Math.max(300, Number(process.env.DOT_CORPORATIVO_RESPONSE_TOKENS || 1200)),
-};
-
-
-const DOT_TOKEN_RESERVATION_TTL_MS = Math.max(
-  5_000,
-  Number(process.env.DOT_TOKEN_RESERVATION_TTL_MS || 30_000),
-);
-const dotTokenReservations = new Map<string, { tokens: number; expiresAt: number }>();
-
-function cleanupDotTokenReservations(now = Date.now()) {
-  for (const [key, reservation] of dotTokenReservations) {
-    if (reservation.expiresAt <= now) dotTokenReservations.delete(key);
-  }
-}
+// O orçamento do Dot vive em `services/dotLedger.ts` (reserva durável,
+// vinculada ao consumo real em `ai_usage`). Aqui ficam apenas os adaptadores
+// que mantêm o contrato das respostas HTTP.
 
 function dotPlanKey(plan?: string | null): 'rei' | 'corporativo' | null {
-  // Sem plano oficial identificado, não há chave de cota nem fallback para Rei.
+  // Sem plano oficial identificado não há chave de cota nem fallback para Rei.
   const normalized = normalizePlan(plan);
   return normalized === 'rei' || normalized === 'corporativo' ? normalized : null;
 }
 
-function dotResponseTokenLimit(plan?: string | null): number {
-  const key = dotPlanKey(plan);
-  return key ? (DOT_RESPONSE_TOKEN_LIMITS[key] || 0) : 0;
-}
-
-async function checkDotTokenBudget(
-  empresaId: string | null | undefined,
-  plan: string | null | undefined,
-): Promise<{ ok: boolean; used: number; feature_used: number; limit: number; feature_limit: number; response_limit: number; remaining: number; feature_remaining: number; feedback_limit: number }> {
-  const normalizedPlan = dotPlanKey(plan);
-  const responseLimit = dotResponseTokenLimit(plan);
-  if (!normalizedPlan) {
-    return { ok: false, used: 0, feature_used: 0, limit: 0, feature_limit: 0, response_limit: 0, remaining: 0, feature_remaining: 0, feedback_limit: 0 };
-  }
-  if (!empresaId) {
-    return { ok: true, used: 0, feature_used: 0, limit: 0, feature_limit: 0, response_limit: responseLimit, remaining: responseLimit, feature_remaining: responseLimit, feedback_limit: 0 };
-  }
-
-  cleanupDotTokenReservations();
-  const featureLimit = getFeatureTokenLimit(normalizedPlan, 'dot');
-  const feedbackLimit = getTokenLimit(normalizedPlan);
-  let featureUsed: number;
-  try {
-    featureUsed = await tokensUsadosFeatureMes(empresaId, 'dot');
-  } catch (error: any) {
-    // Fail-closed: se a leitura da cota isolada do DOT falhar, negamos a
-    // resposta em vez de tratá-la como "zero usado" — o que liberaria tokens
-    // ilimitados justamente quando o controle está indisponível.
-    console.error('[dot] falha ao ler a cota isolada do DOT:', error?.message || error);
-    return {
-      ok: false,
-      used: 0,
-      feature_used: 0,
-      limit: featureLimit,
-      feature_limit: featureLimit,
-      response_limit: responseLimit,
-      remaining: 0,
-      feature_remaining: 0,
-      feedback_limit: feedbackLimit,
-    };
-  }
-  const key = empresaId;
-  const reserved = dotTokenReservations.get(key)?.tokens || 0;
-
-  // ISOLAMENTO CRÍTICO: DOT verifica somente sua própria cota.
-  // O orçamento de feedback é reservado em outro namespace e nunca é
-  // subtraído aqui. Assim, uma conversa pesada no DOT não bloqueia
-  // análise de reviews, sentimento, tags ou respostas de avaliações.
-  const featureRemaining = Math.max(0, featureLimit - featureUsed - reserved);
-
-  if (featureLimit <= 0 || featureRemaining < responseLimit) {
-    return {
-      ok: false,
-      used: featureUsed,
-      feature_used: featureUsed,
-      limit: featureLimit,
-      feature_limit: featureLimit,
-      response_limit: responseLimit,
-      remaining: featureRemaining,
-      feature_remaining: featureRemaining,
-      feedback_limit: feedbackLimit,
-    };
-  }
-
-  dotTokenReservations.set(key, {
-    tokens: reserved + responseLimit,
-    expiresAt: Date.now() + DOT_TOKEN_RESERVATION_TTL_MS,
-  });
-
-  return {
-    ok: true,
-    used: featureUsed,
-    feature_used: featureUsed,
-    limit: featureLimit,
-    feature_limit: featureLimit,
-    response_limit: responseLimit,
-    remaining: featureRemaining - responseLimit,
-    feature_remaining: featureRemaining - responseLimit,
-    feedback_limit: feedbackLimit,
-  };
-}
-
-const DOT_TOKEN_WARNING_THRESHOLD = 0.8;
-
 /**
- * Instantâneo de cota isolada do DOT para exibição. Falha fechada na leitura:
- * sem valor confiável, a cota é apresentada como esgotada (nunca como livre).
+ * Instantâneo de cota isolada do DOT para exibição. Falha fechada: o ledger
+ * devolve `exhausted: true` quando não há leitura confiável.
  */
 async function dotFeatureTokenSnapshot(empresaId: string | null | undefined, plan: string | null | undefined) {
-  const planKey = dotPlanKey(plan);
-  const limit = planKey ? getFeatureTokenLimit(planKey, 'dot') : 0;
-  if (!empresaId || limit <= 0) {
-    return { used: 0, limit, remaining: Math.max(0, limit) };
-  }
-  try {
-    const used = await tokensUsadosFeatureMes(empresaId, 'dot');
-    return { used, limit, remaining: Math.max(0, limit - used) };
-  } catch (error: any) {
-    console.error('[dot] falha ao ler tokens do DOT para exibição:', error?.message || error);
-    return { used: limit, limit, remaining: 0 };
-  }
+  const snapshot = await getDotBudgetSnapshot(empresaId, dotPlanKey(plan));
+  return { used: snapshot.used, limit: snapshot.limit, remaining: snapshot.remaining };
 }
 
 async function getDotTokenUsage(empresaId: string | null | undefined, plan: string | null | undefined) {
-  const snapshot = await dotFeatureTokenSnapshot(empresaId, plan);
-  const { limit } = snapshot;
-  if (!empresaId || limit <= 0) {
-    return { used: 0, limit, percent: 0, warning: false, exhausted: false, remaining: Math.max(0, limit) };
-  }
-  const used = snapshot.used;
-  const percent = limit > 0 ? used / limit : 0;
+  const snapshot = await getDotBudgetSnapshot(empresaId, dotPlanKey(plan));
   return {
-    used,
-    limit,
-    percent,
-    warning: percent >= DOT_TOKEN_WARNING_THRESHOLD && percent < 1,
-    exhausted: used >= limit,
+    used: snapshot.used,
+    limit: snapshot.limit,
+    percent: snapshot.percent,
+    warning: snapshot.warning,
+    exhausted: snapshot.exhausted,
     remaining: snapshot.remaining,
   };
 }
 
-function releaseDotTokenReservation(empresaId: string | null | undefined, reserved: number) {
-  if (!empresaId) return;
-  const current = dotTokenReservations.get(empresaId);
-  if (!current) return;
-  const next = Math.max(0, current.tokens - Math.max(0, reserved));
-  if (next === 0) dotTokenReservations.delete(empresaId);
-  else dotTokenReservations.set(empresaId, { ...current, tokens: next });
-}
-
 function cleanMessage(value: unknown): string {
   return String(value ?? '').trim().slice(0, 4000);
 }
@@ -296,7 +185,30 @@ function buildConversation(context: string, history: ChatItem[], message: string
 
 // Regra única de entrada no Dot (auth + assinatura/trial + plano Rei/Corporativo).
 // A mesma função é usada por /api/dot/*, /api/dot/agent/* e pelas permissões.
+/**
+ * Instância do Express usada por `resolveDotAccess`. O gancho `filtra.test.auth`
+ * é lido SOMENTE quando `NODE_ENV === 'test'`; em produção é inerte.
+ */
+let routesApp: { get: (key: string) => unknown } | null = null;
+
 async function resolveDotAccess(req: Request): Promise<DotAccess> {
+  const testAuth = process.env.NODE_ENV === 'test'
+    ? ((routesApp?.get('filtra.test.auth') ?? null) as
+        | { empresaId: string; plan: string; userId: string | null; demo?: boolean }
+        | null)
+    : null;
+  if (testAuth) {
+    const plan = normalizePlan(testAuth.plan);
+    return {
+      allowed: true,
+      demo: Boolean(testAuth.demo),
+      empresaId: testAuth.empresaId,
+      plan,
+      planLabel: plan ? planLabel(plan) : null,
+      planIdentified: plan !== null,
+      userId: testAuth.userId,
+    };
+  }
   const gate = await resolveDotGate(req);
   return {
     allowed: gate.allowed,
@@ -339,7 +251,47 @@ function deny(res: Response, access: DotAccess) {
   });
 }
 
+/**
+ * Liquida (ou segura) a reserva de UMA chamada de IA que falhou.
+ *
+ *  - resultado SEM envio comprovado (ou recusa HTTP estruturada) -> liberar;
+ *  - resultado ambíguo (timeout, conexão cortada, 5xx, corpo inválido) ->
+ *    a reserva permanece ABERTA com `ambiguous=1` até a reconciliação.
+ */
+async function settleDotCallFailure(params: {
+  error: unknown;
+  providerCalled: boolean;
+  empresaId: string;
+  reservationId: number;
+  reservedTokens: number;
+}): Promise<void> {
+  const { error, providerCalled } = params;
+  const outcome = providerCalled ? classifyDotProviderError(error) : 'not_sent';
+  const provenNotSent = !providerCalled || isProvenNotSent(outcome, error);
+  if (provenNotSent) {
+    const released = await releaseDotReservation({
+      empresaId: params.empresaId,
+      reservationId: params.reservationId,
+      provenNotSent: true,
+      reason: describeDotProviderOutcome(outcome),
+    });
+    if (!released.ok) console.error('[dot-ledger] liberação recusada:', released.reason);
+    return;
+  }
+  const ambiguous = await finalizeDotReservation({
+    empresaId: params.empresaId,
+    reservationId: params.reservationId,
+    tokens: null,
+    estimatedTokens: params.reservedTokens,
+    ambiguous: true,
+    ambiguousReason: describeDotProviderOutcome(outcome),
+  });
+  if (!ambiguous.ok) console.error('[dot-ledger] falha ao marcar reserva ambígua:', ambiguous.reason);
+  console.warn('[dot-ledger] resultado ambíguo: reserva mantida e orçamento comprometido até reconciliação.');
+}
+
 export function mountDotRoutes(app: Express) {
+  routesApp = app as unknown as { get: (key: string) => unknown };
   // CSRF dedicado para mutações de empresa do Dot. O header é exigido antes
   // de qualquer autenticação/permissão: um POST cross-site não consegue
   // definir header customizado, mesmo com cookie SameSite=None em produção.
@@ -412,6 +364,29 @@ export function mountDotRoutes(app: Express) {
     res.json({ ok: true, demo: access.demo, result });
   });
 
+  // Painel de orçamento do Dot: consumo real, reservas abertas e reservas
+  // ambíguas aguardando reconciliação. Nunca expõe dados de outra empresa.
+  app.get('/api/dot/budget', async (req: Request, res: Response) => {
+    const access = await resolveDotAccess(req);
+    if (!access.allowed || !access.empresaId) return deny(res, access);
+    const snapshot = await getDotBudgetSnapshot(access.empresaId, access.plan);
+    const open = access.demo ? [] : await listOpenDotReservations(access.empresaId);
+    res.json({
+      ok: true,
+      demo: access.demo,
+      budget: snapshot,
+      open_reservations: open.map((item) => ({
+        id: item.id,
+        status: item.status,
+        tokens_reserved: item.tokens_reserved,
+        tokens_estimated: item.tokens_estimated,
+        ambiguous: Number(item.ambiguous) === 1,
+        created_at: item.created_at,
+        expires_at: item.expires_at,
+      })),
+    });
+  });
+
   app.get('/api/dot/decisions', async (req: Request, res: Response) => {
     const access = await resolveDotAccess(req);
     if (!access.allowed || !access.empresaId) return deny(res, access);
@@ -679,8 +654,8 @@ export function mountDotRoutes(app: Express) {
     res.json({
       ok: true,
       demo: access.demo,
-      plan: access.plan || 'rei',
-      plan_label: access.planLabel || 'Rei',
+      plan: access.plan ?? null,
+      plan_label: access.planLabel ?? null,
       context,
       briefing: access.demo
         ? {
@@ -710,7 +685,7 @@ export function mountDotRoutes(app: Express) {
     return res.json({
       ok: true,
       demo: access.demo,
-      plan: access.plan || 'rei',
+      plan: access.plan ?? null,
       proposal: prepareDotAction(action, access.demo),
     });
   });
@@ -724,19 +699,38 @@ export function mountDotRoutes(app: Express) {
   });
 
   app.post('/api/dot/explain', dotLimiter, async (req: Request, res: Response) => {
-    const access = await resolveDotGate(req);
-    if (!access.allowed) {
-      return res.status(403).json({ error: access.reason || 'Filtra Dot desativado.' });
-    }
+    const access = await resolveDotAccess(req);
+    if (!access.allowed) return deny(res, access);
 
     const responseText = cleanMessage(req.body?.response_text).slice(0, 5000);
     if (!responseText) return res.status(400).json({ error: 'Resposta do Dot obrigatória.' });
 
+    // Demonstração não reserva (não há empresa para debitar); conta autenticada
+    // usa o MESMO ledger da conversa: reserva -> envio -> finalização real.
+    const companyId = access.demo ? null : access.empresaId || null;
+    const reservation = companyId
+      ? await reserveDotExecution({
+          empresaId: companyId,
+          plan: access.plan,
+          executionRef: 'dot_explain:' + companyId + ':' + Date.now(),
+          responseLimit: 260,
+        })
+      : undefined;
+    if (companyId && reservation && !reservation.ok) {
+      if (!reservation.unavailable && reservation.code === 'DOT_TOKEN_LIMIT') {
+        return res.status(429).json({ ok: false, error: 'O orçamento de IA do plano para este período foi atingido.', code: 'DOT_TOKEN_LIMIT', token_scope: DOT_FEATURE, response_limit: reservation.snapshot.response_limit });
+      }
+      return res.status(503).json({ ok: false, error: 'O controle de orçamento do Filtra Dot está temporariamente indisponível.', code: 'DOT_BUDGET_UNAVAILABLE' });
+    }
+
+    const reservationId = reservation?.reservation?.id ?? null;
+
+    // Fase 1 — contexto e prompt (antes de qualquer envio): se falhar, nada foi
+    // enviado ao provedor e a reserva pode ser liberada com segurança.
+    let prompt: string;
     try {
-      const context = access.demo
-        ? DEMO_CONTEXT
-        : await loadDotRealContext(access.empresaId as string);
-      const prompt = [
+      const context = access.demo ? DEMO_CONTEXT : await loadDotRealContext(companyId as string);
+      prompt = [
         '=== CONTEXTO CONTROLADO ===',
         redactSensitive(context),
         '=== RESPOSTA DO DOT A SER EXPLICADA ===',
@@ -744,25 +738,42 @@ export function mountDotRoutes(app: Express) {
         '=== FIM ===',
         'Explique apenas as evidências e limitações observáveis que sustentam a resposta. Não revele raciocínio interno.',
       ].join('\n\n');
+    } catch (error: any) {
+      if (companyId && reservationId) {
+        await releaseDotReservation({ empresaId: companyId, reservationId, provenNotSent: true, reason: 'falha antes do envio ao provedor' });
+      }
+      console.error('[Filtra Dot explain]', error?.message || error);
+      return res.status(503).json({ error: 'Não foi possível explicar a evidência desta resposta agora.' });
+    }
+
+    // Fase 2 — chamada ao provedor. A marca precede o envio; o sweep nunca
+    // libera esta reserva sem finalização.
+    if (companyId && reservationId) {
+      const marked = await markDotReservationSent({ empresaId: companyId, reservationId });
+      if (!marked.ok) {
+        return res.status(503).json({ ok: false, error: 'O controle de orçamento do Filtra Dot está temporariamente indisponível.', code: 'DOT_BUDGET_UNAVAILABLE' });
+      }
+    }
 
+    try {
       const result = await callAI(
         EXPLAIN_SYSTEM_PROMPT,
         prompt,
         260,
         0.25,
-        { empresaId: access.empresaId || null, tipo: 'filtra_dot_explain', feature: access.demo ? undefined : 'dot' }
+        { empresaId: companyId, tipo: 'filtra_dot_explain', feature: companyId ? DOT_FEATURE : undefined, skipUsageRecord: true }
       );
-
-      return res.json({
-        ok: true,
-        explanation: redactSensitive(result.text),
-        demo: access.demo,
-      });
+      if (companyId && reservationId) {
+        const finalized = await finalizeDotReservation({ empresaId: companyId, reservationId, tokens: result.tokens, inputTokens: result.input_tokens, outputTokens: result.output_tokens, provider: result.provider, tipo: 'filtra_dot_explain' });
+        if (!finalized.ok) console.error('[dot-ledger] finalização do explain falhou; reserva mantida para reconciliação:', finalized.reason);
+      }
+      return res.json({ ok: true, explanation: redactSensitive(result.text), demo: access.demo });
     } catch (error: any) {
+      if (companyId && reservationId) {
+        await settleDotCallFailure({ error, providerCalled: true, empresaId: companyId, reservationId, reservedTokens: 260 });
+      }
       console.error('[Filtra Dot explain]', error?.message || error);
-      return res.status(503).json({
-        error: 'Não foi possível explicar a evidência desta resposta agora.',
-      });
+      return res.status(503).json({ error: 'Não foi possível explicar a evidência desta resposta agora.' });
     }
   });
 
@@ -797,8 +808,9 @@ export function mountDotRoutes(app: Express) {
         }
       : await loadDotContextForMessage(access.empresaId as string, message);
 
+    const feedbackTokenLimit = access.plan ? getTokenLimit(access.plan) : null;
+
     // Perguntas puramente factuais podem sair do cache sem consumir a cota de IA.
-    // Raciocínio, explicação, comparação e estado temporal continuam passando pela IA.
     if (!access.demo && contextResult.cacheHit) {
       const cachedAnswer = buildCachedDotAnswer(message, contextResult.snapshot);
       if (cachedAnswer) {
@@ -813,12 +825,12 @@ export function mountDotRoutes(app: Express) {
           latency_ms: 0,
           tokens_used: 0,
           demo: false,
-          plan: access.plan || 'rei',
-          plan_label: access.planLabel || 'Rei',
+          plan: access.plan ?? null,
+          plan_label: access.planLabel ?? null,
           session_id: requestedSessionId,
           memory_turns: Math.floor(history.length / 2),
-          token_scope: 'dot',
-          feedback_token_limit: getTokenLimit(access.plan || 'rei'),
+          token_scope: DOT_FEATURE,
+          feedback_token_limit: feedbackTokenLimit,
           feedback_isolated: true,
           response_token_limit: 0,
           context_mode: 'cached',
@@ -832,9 +844,7 @@ export function mountDotRoutes(app: Express) {
       }
     }
 
-    // Reutiliza respostas de raciocínio quando a intenção é semanticamente equivalente
-    // e o fingerprint dos dados é idêntico. Isso evita gastar tokens novamente
-    // para perguntas repetidas ou parafraseadas sem sacrificar frescor.
+    // Reutiliza respostas de raciocínio semanticamente equivalentes com o mesmo fingerprint.
     if (!access.demo && contextResult.fingerprint) {
       const semanticCached = await getDotResponseCache(
         access.empresaId as string,
@@ -859,12 +869,12 @@ export function mountDotRoutes(app: Express) {
           tokens_used: 0,
           tokens_saved_estimate: semanticCached.tokens_used,
           demo: false,
-          plan: access.plan || 'rei',
-          plan_label: access.planLabel || 'Rei',
+          plan: access.plan ?? null,
+          plan_label: access.planLabel ?? null,
           session_id: requestedSessionId,
           memory_turns: Math.floor(history.length / 2),
-          token_scope: 'dot',
-          feedback_token_limit: getTokenLimit(access.plan || 'rei'),
+          token_scope: DOT_FEATURE,
+          feedback_token_limit: feedbackTokenLimit,
           feedback_isolated: true,
           response_token_limit: 0,
           context_mode: 'cached',
@@ -878,55 +888,99 @@ export function mountDotRoutes(app: Express) {
       }
     }
 
-    // Trava final: antes de chamar qualquer modelo, reservamos o máximo de saída
-    // permitido. Assim, uma resposta nunca pode iniciar se o orçamento restante
-    // for menor que o teto da própria resposta.
-    const tokenBudget = await checkDotTokenBudget(access.empresaId, access.plan);
-    if (!tokenBudget.ok) {
-      return res.status(429).json({
+    // Trava final: reserva DURÁVEL (`services/dotLedger.ts`). Demonstração não
+    // reserva (não há empresa para debitar); conta autenticada segue o ledger
+    // completo: reserva -> envio marcado -> finalização com consumo real.
+    const companyId = access.demo ? null : access.empresaId || null;
+    const reservation = companyId
+      ? await reserveDotExecution({
+          empresaId: companyId,
+          plan: access.plan,
+          executionRef: 'dot_chat:' + sessionId + ':' + Date.now(),
+        })
+      : undefined;
+    const tokenBudget = reservation?.snapshot;
+    if (companyId && reservation && !reservation.ok) {
+      if (!reservation.unavailable && reservation.code === 'DOT_TOKEN_LIMIT') {
+        return res.status(429).json({
+          ok: false,
+          error: 'O orçamento de IA do plano para este período foi atingido.',
+          code: 'DOT_TOKEN_LIMIT',
+          tokens_used: tokenBudget!.used,
+          token_limit: tokenBudget!.limit,
+          token_scope: DOT_FEATURE,
+          feedback_token_limit: tokenBudget!.feedback_limit,
+          feedback_isolated: true,
+          feature_tokens_used: tokenBudget!.used,
+          feature_token_limit: tokenBudget!.limit,
+          response_limit: tokenBudget!.response_limit,
+          tokens_remaining: tokenBudget!.remaining,
+          feature_tokens_remaining: tokenBudget!.remaining,
+        });
+      }
+      return res.status(503).json({
         ok: false,
-        error: 'O orçamento de IA do plano para este período foi atingido.',
-        code: 'DOT_TOKEN_LIMIT',
-        tokens_used: tokenBudget.feature_used,
-        token_limit: tokenBudget.feature_limit,
-        token_scope: 'dot',
-        feedback_token_limit: tokenBudget.feedback_limit,
-        feedback_isolated: true,
-        feature_tokens_used: tokenBudget.feature_used,
-        feature_token_limit: tokenBudget.feature_limit,
-        response_limit: tokenBudget.response_limit,
-        tokens_remaining: tokenBudget.remaining,
-        feature_tokens_remaining: tokenBudget.feature_remaining,
+        error: 'O controle de orçamento do Filtra Dot está temporariamente indisponível.',
+        code: 'DOT_BUDGET_UNAVAILABLE',
       });
     }
 
-    const reservedTokens = tokenBudget.response_limit;
+    const activeReservation = reservation?.reservation as DotReservation | undefined;
+    const responseLimit = tokenBudget?.response_limit ?? dotResponseTokenLimit(access.plan);
+    const reservedTokens = responseLimit;
+    let providerCalled = false;
+
+    // Marca o envio ANTES do provedor: o sweep nunca libera esta reserva sem
+    // finalização. Se a marca falhar, a chamada não acontece.
+    if (companyId && activeReservation) {
+      const marked = await markDotReservationSent({ empresaId: companyId, reservationId: activeReservation.id });
+      if (!marked.ok) {
+        return res.status(503).json({ ok: false, error: 'O controle de orçamento do Filtra Dot está temporariamente indisponível.', code: 'DOT_BUDGET_UNAVAILABLE' });
+      }
+    }
 
     try {
       const responseSystem = `${SYSTEM}
-ORÇAMENTO DESTA RESPOSTA: até ${tokenBudget.response_limit} tokens de saída.
+ORÇAMENTO DESTA RESPOSTA: até ${responseLimit} tokens de saída.
 CONTEXTO: ${contextResult.decision.mode}. ${contextResult.decision.reason}
 REGRA DE FRESCOR: use fatos persistidos do contexto quando suficientes; quando a pergunta pedir estado atual, causa, impacto, comparação, recomendação ou decisão, raciocine novamente com os dados verificados nesta solicitação.
 Entregue uma resposta completa dentro desse orçamento. Priorize, nesta ordem: conclusão, evidências, impacto, recomendação e próximo passo. Evite introduções e repetições desnecessárias.`;
 
       const routing = selectDotModel(message);
+      providerCalled = true;
       const result = await callAI(
         responseSystem,
         buildConversation(contextResult.context, history, message),
-        tokenBudget.response_limit,
+        responseLimit,
         0.45,
         {
-          empresaId: access.empresaId || null,
+          empresaId: companyId,
           tipo: 'filtra_dot_chat',
-          feature: 'dot',
+          feature: companyId ? DOT_FEATURE : undefined,
           model: routing.model,
+          skipUsageRecord: true,
         }
       );
 
-      releaseDotTokenReservation(access.empresaId, reservedTokens);
+      // Consumo real (in+out), nunca o teto; fechado na mesma transação e
+      // idempotente por reserva (retry não duplica `ai_usage`).
+      if (companyId && activeReservation) {
+        const finalized = await finalizeDotReservation({
+          empresaId: companyId,
+          reservationId: activeReservation.id,
+          tokens: result.tokens,
+          inputTokens: result.input_tokens,
+          outputTokens: result.output_tokens,
+          provider: result.provider,
+          tipo: 'filtra_dot_chat',
+        });
+        if (!finalized.ok) {
+          console.error('[dot-ledger] finalização falhou; reserva mantida para reconciliação:', finalized.reason);
+        }
+      }
+      const after = await getDotBudgetSnapshot(companyId, access.plan);
+      if (companyId) emitDotBudgetAlert(buildDotBudgetAlert(after));
 
-      // Guarda somente respostas geradas por IA e vinculadas ao fingerprint atual.
-      // Uma nova avaliação ou mudança relevante invalida esse cache.
       if (!access.demo && contextResult.fingerprint && result.text) {
         await putDotResponseCache(
           access.empresaId as string,
@@ -950,36 +1004,42 @@ Entregue uma resposta completa dentro desse orçamento. Priorize, nesta ordem: c
         latency_ms: result.latency_ms,
         tokens_used: result.tokens,
         demo: access.demo,
-        plan: access.plan || 'rei',
-        plan_label: access.planLabel || 'Rei',
+        plan: access.plan ?? null,
+        plan_label: access.planLabel ?? null,
         session_id: requestedSessionId,
         memory_turns: Math.floor(history.length / 2),
-        token_limit: tokenBudget.limit || null,
-        token_scope: 'dot',
-        feedback_token_limit: tokenBudget.feedback_limit || null,
+        token_limit: tokenBudget?.limit ?? null,
+        token_scope: DOT_FEATURE,
+        feedback_token_limit: feedbackTokenLimit,
         feedback_isolated: true,
-        response_token_limit: tokenBudget.response_limit,
+        response_token_limit: responseLimit,
         token_warning_threshold: 0.8,
-        token_warning: tokenBudget.feature_limit > 0 && ((tokenBudget.feature_used + result.tokens) / tokenBudget.feature_limit) >= 0.8,
-        tokens_remaining_estimate: tokenBudget.limit
-          ? Math.max(0, tokenBudget.limit - tokenBudget.used - result.tokens)
-          : null,
-        dot_token_limit: tokenBudget.feature_limit || null,
-        dot_tokens_used: tokenBudget.feature_used + result.tokens,
+        token_warning: after.warning,
+        tokens_remaining_estimate: tokenBudget?.limit ? after.remaining : null,
+        dot_token_limit: tokenBudget?.limit ?? null,
+        dot_tokens_used: after.used,
         context_mode: contextResult.decision.mode,
         context_source: contextResult.decision.dataSource,
         context_refresh_required: contextResult.decision.refreshRequired,
         context_reason: contextResult.decision.reason,
-        dot_tokens_remaining_estimate: tokenBudget.feature_limit
-          ? Math.max(0, tokenBudget.feature_limit - tokenBudget.feature_used - result.tokens)
-          : null,
+        dot_tokens_remaining_estimate: tokenBudget?.limit ? after.remaining : null,
       });
     } catch (error: any) {
-      releaseDotTokenReservation(access.empresaId, reservedTokens);
-      console.error('[Filtra Dot]', error?.message || error);
+      // Só libera com prova de não envio; ambíguo mantém a reserva até reconciliação.
+      if (companyId && activeReservation) {
+        await settleDotCallFailure({
+          error,
+          providerCalled,
+          empresaId: companyId,
+          reservationId: activeReservation.id,
+          reservedTokens,
+        });
+      }
+      const messageText = String(error?.message || error);
+      console.error('[Filtra Dot]', messageText);
       return res.status(503).json({
         error: 'O Filtra Dot está sem um provedor de IA disponível no localhost.',
-        detail: process.env.NODE_ENV === 'production' ? undefined : String(error?.message || error),
+        detail: process.env.NODE_ENV === 'production' ? undefined : messageText,
       });
     }
   });

```
