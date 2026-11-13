# DSV4 — Implementação controlada do DOT Durable Token Ledger — Lote 3 (rotas DOT)

**HEAD-base:** `6f63380d9583fef9d6178cf3433e05f570b3b924` (cadeia: `6f63380` → `b69bf3b` → `a907a34`)
**Branch:** `reconcile/dot-production-2026-11-06` (inalterada)
**Escopo:** `routes/dotRoutes.ts` (v2, sem gancho de teste), `routes/dotAdminRoutes.ts` (orçamento/reconciliação) e testes HTTP com **JWT real**. Sem scheduler, worker, server, retry/acquisition, CI ou `.env.example`.

## 1. Publicação documental (GitHub)

| Item | Valor |
|---|---|
| Repositório | `LU9DI/backend` |
| Branch | `audit/dot-ledger-2026-11-06` |
| Commit | `00993e33d913dd4ed5adb92817743ebfb24aaae5` |
| Conteúdo | **55 arquivos** em `review/` + `stash-critical-diff.txt` + `head-vs-stash-critical-diff.txt` (nenhum `.ts` de implementação) |
| Inclui | relatórios dos Lotes 1 e 2 (`ledger-implementation-batch-1.md`, `-batch-2.md`) |
| Segredos | varredura encontrou apenas **placeholders de `.env.example`** (nenhum segredo real) |

Primeiro commit `2d7090a` (53 arquivos); o commit `00993e3` incluiu os relatórios dos Lotes 1 e 2 (que, por serem rastreados na branch de implementação, não entraram no primeiro commit). Confirmado por `git ls-remote` e pela API do GitHub.

## 2. Artefatos de revisão usados (SHA-256)

| Artefato | SHA-256 |
|---|---|
| `review/dotRoutes.ledger.proposed.v2.ts.txt` | `cf1f05cd97c45663de718080807bbe67affce119cda783a60e52be93c2d6a8fa` |
| `stash@{0}:routes/dotAdminRoutes.ts` (fonte do delta) | `facb69dc2f64f72e9e3e72315c986c36e49a0d1b5012d1b901b19bfb6e53288d` |
| `review/ledger-cross-review.md` | `e138226a59fc265db2af96375b5547f2f289df7931f0e7f17723eb84a2fafdd0` |

## 3. Arquivos alterados

- `routes/dotRoutes.ts` — v2: **sem `filtra.test.auth`/`routesApp`**; chat/explain sob o ledger durável; `GET /api/dot/budget`; `dotPlanKey` fail-closed (#141).
- `routes/dotAdminRoutes.ts` — `GET /api/dot/admin/budget` e `POST /api/dot/admin/budget/reconcile` (proprietário + sessão administrativa + `X-Dot-Admin` + auditoria).
- `tests/dotChatLedger.http.test.ts` (**novo**) — JWT real + `X-Dot-Csrf`; 8 testes.
- `tests/dotExplainLedger.http.test.ts` (**novo**) — JWT real + `X-Dot-Csrf`; demo via `DOT_DEMO_MODE`; 6 testes.
- `tests/dotAdminBudget.http.test.ts` (**novo**) — JWT + PIN + sessão + reconciliação; 14 testes.

## 4. Contratos e segurança preservados

- **CSRF** `X-Dot-Csrf: 1` obrigatório nas mutações de empresa (os testes o enviam).
- **Autorização/permissões**: `requireMutationPermission`, `requireDotAdminSession`, `ensureOwner`.
- **Isolamento por tenant**: reconciliação de outra empresa → 409 (testado).
- **Separação aprovação × execução**: intacta (`/actions/:id/*`).
- **Fail-closed**: plano desconhecido sem orçamento; ledger indisponível ⇒ 503; demo não reserva.
- **Reserva antes do envio**; **falha ambígua não libera** (429 sem evidência ⇒ `pending`+`ambiguous`).
- **Nenhum gancho de teste** nas rotas (`grep filtra.test.auth/routesApp` = 0).

## 5. Testes executados — resultados REAIS

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit` | **EXIT 0** (após as edições dos testes) |
| `node --import tsx --test --test-concurrency=1 tests/dotChatLedger.http.test.ts tests/dotExplainLedger.http.test.ts tests/dotAdminBudget.http.test.ts` | **28/28 PASS**, EXIT 0 |
| Regressões: `dotRouteProtection`, `dotRouting`, `dot-security-hardening`, `dot-plan-identification`, `dotCoreRegression`, `dotEmpresaOwner` | **52/52 PASS**, EXIT 0 |

Cobertura HTTP comprovada: chat (sucesso/ambíguo/recusa com evidência/**429 sem evidência ambíguo**/sem provedor/orçamento esgotado/retry sem duplicar/budget sem dado sensível); explain (autenticado in/out, ambíguo, recusa com evidência, 429 sem evidência, esgotado, demo sem consumo); admin (sem JWT, não-dono, PIN, sessão, reconcile settle/release, entrada inválida, isolamento entre empresas, revogação de sessão).

**PostgreSQL:** a validação PG do Lote 1 **continua BLOCKED** (sem ambiente). Nenhum teste PG foi executado ou declarado aprovado.

## 6. Diffstat

```
 routes/dotAdminRoutes.ts              |  90 +++++++++
 routes/dotRoutes.ts                   | 470 +++++++++++++++++++++-------------
 (novos) tests/dotAdminBudget.http.test.ts · dotChatLedger.http.test.ts · dotExplainLedger.http.test.ts
```

## 7. Riscos e pendências

1. **PostgreSQL BLOCKED (herdado):** `dotLedger.pg.test.ts` + concorrência multi-processo não executados → **bloqueia a aprovação final** até PG 17 descartável (local C).
2. Alinhamento necessário com a regra do Lote 2: os testes de recusa 429 foram ajustados — **429 sem evidência é ambíguo** (reserva aberta), e só libera com evidência explícita.
3. **Pendente Lote 4:** `dotScheduler`, `dotAgentWorker`, `server`, `retryQueue`/`acquisitionEngine`/`acquisitionReplenisher` (stop*), `ci.yml`, `.env.example`, correções PG de `dotExecutionAtomicity`/`dotActionConcurrency`.
4. `dotAgentWorker`/`dotScheduler` ainda têm o comportamento antigo de stop (sem drain) — o `server` do Lote 4 integra as versões propostas.
