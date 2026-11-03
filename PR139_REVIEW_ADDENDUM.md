# PR #139 — Adendo de revisão: identidade do aprovador e auditoria interna

**Worktree:** `C:\Users\lucas\backend-pr139-atomicity`
**Branch:** `fix/dot-atomicity-sod`
**HEAD antes desta correção:** `c9e4a897f432202b7e093f079aa82f794f8d48cf`
**Data:** 2026-11-03

> Sem commit, push, merge ou deploy nesta rodada.

## 1. Alterações em `services/dotActionQueue.ts`

Em `approveDotAction()`:

- `actorUserId` é normalizado: apenas string não vazia após `trim` conta como identidade; todo o resto vira `null`.
- Evento `prepared` com `actor_type='user'`:
  - exige `actor_id` válido **e** identidade do aprovador;
  - sem qualquer um deles, lança `DotApprovalSeparationError` (fail-closed);
  - mesmo usuário só aprova se for owner verificado em `empresa_owners` (`owner_override`);
  - usuários diferentes registram `distinct_actors`.
- Evento `prepared` com `actor_type='dot'` registra `internal_actor`.
- Evento `prepared` com tipo desconhecido ou identidade inválida bloqueia a aprovação.
- Ausência de evento `prepared` mantém a compatibilidade histórica `no_preparer_recorded`.
- O evento `approved` agora grava:
  - `actor_type='user'` e `actor_id` quando há aprovador identificado;
  - `actor_type='dot'` e `actor_id=NULL` em chamada interna sem identidade;
  - metadata com `approver_actor_type` e `approver_id`, além de `separation_decision`, `owner_override`, `preparer_id` e `preparer_actor_type`.

## 2. Testes adicionados em `tests/dotApprovalSeparation.test.ts`

1. **Preparador humano sem identidade do aprovador**: bloqueia com `DOT_SEPARATION_OF_DUTIES`; ação continua `prepared`, `approved_at` nulo, decisão continua `prepared` e não existe evento `approved`.
2. **Aprovação interna sem identidade**: preparação automática (`dot`) aprovada sem identidade registra `actor_type='dot'`, `actor_id=NULL` e metadata `approver_actor_type='dot'`, `approver_id=NULL`.

## 3. Testes executados nesta rodada (resultados reais)

Comandos executados no worktree, todos com `NODE_ENV=test`:

```powershell
node --import tsx --test --test-concurrency=1 tests\dotApprovalSeparation.test.ts
```
→ **8/8 aprovados, 0 falhas**

```powershell
node --import tsx --test --test-concurrency=1 tests\dotActionQueue.test.ts
```
→ **6/6 aprovados, 0 falhas**

```powershell
node --import tsx --test --test-concurrency=1 tests\dotCoreRegression.test.ts
```
→ **14/14 aprovados, 0 falhas**

```powershell
node --import tsx --test --test-concurrency=1 --test-timeout=240000 tests\dotAgentMissionRunner.test.ts
```
→ **4/4 aprovados, 0 falhas**

```powershell
node --import tsx --test --test-concurrency=1 --test-timeout=240000 tests\dotMissionLifecycle.test.ts
```
→ **7/7 aprovados, 0 falhas**

```powershell
node --import tsx --test --test-concurrency=1 --test-timeout=240000 tests\dotRouteProtection.test.ts
```
→ **10/10 aprovados, 0 falhas**, incluindo HTTP 403 `DOT_SEPARATION_OF_DUTIES`

```powershell
node --import tsx --test --test-concurrency=1 --test-timeout=240000 tests\dotExecutionAtomicity.test.ts
```
→ **4/4 aprovados, 0 falhas**

PostgreSQL real (cluster descartável local, PostgreSQL 17.11, banco `filtra_dot_test`):

```powershell
$env:DATABASE_URL='postgresql://postgres@127.0.0.1:55433/filtra_dot_test'
node --import tsx --test --test-concurrency=1 --test-timeout=240000 tests\dotExecutionAtomicity.pg.test.ts
```
→ **3/3 aprovados, 0 falhas**

O cluster foi encerrado ao final.

**Não foram executados nesta rodada** (e, portanto, **não são declarados como aprovados**): a suíte SQLite completa, a suíte PostgreSQL completa (`npm run test:postgres`), o build completo e o `npm audit`. Resultados anteriores não são reapresentados como se pertencessem a esta correção.

## 4. Limitações e avisos

- Testes não executados **não podem ser declarados como aprovados**; a ausência de evidência não é evidência de sucesso.
- Nenhum resultado PostgreSQL foi inventado ou inferido.
- A validação desta rodada cobre os testes direcionados acima; a suíte completa continua sendo necessária antes de qualquer push/merge.
- Não houve commit, push, merge ou deploy.

## 5. Verificações de Git

```text
git diff --check   → sem erros
git status         → apenas as alterações abaixo, sem commit
```

Alterações:
- `services/dotActionQueue.ts` — normalização/validação de identidade e auditoria.
- `tests/dotApprovalSeparation.test.ts` — testes novos de identidade e de contrato `dot`.
- `tests/dotRouteProtection.test.ts` — teste de spoofing de identidade via corpo.
- `PR139_REVIEW_ADDENDUM.md` — este documento.

## 6. Revisão final de SoD (segunda rodada)

### 6.1 Contrato de `dot_action_audit` para `actor_type='dot'`

Contrato confirmado no código e nos testes existentes:

- `tests/dotActionAuditIntegrity.test.ts` (teste “prepare automático do Dot continua auditado como ator dot, sem ator humano”) exige `actor_type='dot'` **e `actor_id = null`**;
- `services/dotActionQueue.ts` grava `dot` sem ator quando a preparação é automática.

Portanto, `actor_id` preenchido em evento `prepared` de tipo `dot` é histórico inválido. `approveDotAction()` agora **rejeita** essa situação com `DotApprovalSeparationError`, sem aprovar a ação. Teste adicionado em `tests/dotApprovalSeparation.test.ts`.

### 6.2 Identidade do aprovador nas rotas

Confirmado: `routes/dotRoutes.ts` chama `approveDotAction(access.empresaId, actionId, access.userId || null)`; `access.userId` vem de `resolveDotGate()`, que verifica o token com `verifyAccessToken()` e extrai `payload.id`. Nenhum campo do corpo é usado para identidade.

O teste de rota agora envia `actorUserId`, `actor_id`, `approver_id` e `approved_by` no corpo, com o token do funcionário, e comprova:

- o `prepared` é auditado com o `actor_id` do token (funcionário), não com o owner spoofado;
- a aprovação continua retornando HTTP 403 `DOT_SEPARATION_OF_DUTIES`.

### 6.3 Consulta de owner

A consulta em `approveDotAction()` passou de `SELECT user_id ... WHERE empresa_id = ? LIMIT 1` para verificação direta de existência:

```sql
SELECT 1 AS ok FROM empresa_owners WHERE empresa_id = ? AND user_id = ?
```

Não há mais leitura de uma linha arbitrária de owners nem comparação posterior; a exceção só existe quando o vínculo exato `(empresa_id, user_id)` existe.

### 6.4 Testes reexecutados nesta rodada

| Teste | Resultado real |
|---|---|
| `tests/dotApprovalSeparation.test.ts` | **9/9 aprovados** |
| `tests/dotRouteProtection.test.ts` | **10/10 aprovados** |
| `tests/dotActionQueue.test.ts` | **6/6 aprovados** |
| `tests/dotActionAuditIntegrity.test.ts` | **4/4 aprovados** |
| `tests/dotExecutionAtomicity.pg.test.ts` (PostgreSQL 17.11 local descartável) | **3/3 aprovados** |
| `npx tsc --noEmit` | **0 erros** |

O cluster PostgreSQL foi encerrado. A suíte completa, o build completo e o `npm audit` **não foram executados nesta rodada** e, portanto, **não são declarados como aprovados**.

## 7. Validação final completa (rodada seguinte)

Esta seção substitui a limitação da seção 6.4: a validação completa foi executada no mesmo worktree, sem commit.

| Verificação | Resultado real |
|---|---|
| Suíte SQLite completa (`npm test`) | **329/329 aprovados**, 0 falhas, 0 ignorados |
| Suíte PostgreSQL completa (`npm run test:postgres`, PostgreSQL 17.11 descartável) | **22/22 aprovados**, 0 falhas, 0 ignorados |
| Testes direcionados (atomicidade, rollback, follow-up, retry, contrato `dot`, SoD, owner override, spoofing, isolamento) | **47/47 aprovados** |
| `npm run build` (`tsc --noEmit`) | **0 erros** |
| `npm audit` | **0 vulnerabilidades** (após override de `@hono/node-server@2.1.6`) |
| `npm audit --omit=dev` | **0 vulnerabilidades** (após override de `@hono/node-server@2.1.6`) |
| `git diff --check` | **0** |

O cluster PostgreSQL foi encerrado. Nenhum commit, push, merge ou deploy foi realizado.

---

## 8. Rodada final — identidade explícita, bloqueio sem `prepared` e auditoria de execução

> **Esta seção SUBSTITUI a seção 1** na parte em que ela aceitava
> `no_preparer_recorded` sem marcador, e **SUBSTITUI os resultados das seções 6/7**,
> que foram obtidos antes desta correção. Nenhum commit, push, merge ou deploy.

### 8.1 Contrato explícito e tipado de ator — `services/dotActor.ts` (novo)

Duas formas válidas, validadas em runtime:

- `{ type: 'user', userId: string }` — usuário autenticado; `userId` é obrigatório
  (normalizado com `trim`, vazio rejeitado);
- `{ type: 'dot', source: 'monitor'|'scheduler'|'system' }` — ator interno
  autorizado, sem ID humano, com origem declarada.

Qualquer outra entrada (`undefined`, `null`, string solta, `{type:'user'}` sem ID,
origem desconhecida) lança `DotActorIdentityError`
(`code = 'DOT_ACTOR_IDENTITY_REQUIRED'`, `status = 403`). **Nenhuma chamada sem
identidade é convertida em ator `dot`.** `dotActorAuditColumns()` deriva
`actor_type`/`actor_id` do ator efetivo (interno → `dot`/`NULL`, nunca “usuário
anônimo”).

### 8.2 `approveDotAction()` — bloqueio sem evento `prepared`

- O ator é resolvido **antes** da transação; identidade ausente/inválida não
  altera decisão, fila nem auditoria.
- **Ausência de evento `prepared` BLOQUEIA a aprovação** com
  `DotApprovalSeparationError` (`DOT_SEPARATION_OF_DUTIES`, HTTP 403). Não há
  mais presunção de preparação pelo Dot.
- Compatibilidade histórica só existe com um **marcador explícito, verificável e
  restrito**: linha na tabela `dot_action_legacy_approval_markers` para o par
  exato `(empresa_id, action_id)` com `marker = 'no_preparer_recorded_v1'`.
  Nada é inserido automaticamente; sem linha, o bloqueio permanece (fail-closed).
  Ação legada só pode ser aprovada por **usuário** autenticado.
- Preparador humano exige aprovador humano distinto; mesmo usuário só aprova se
  for owner exato em `empresa_owners` (`owner_override`); ator interno do Dot não
  aprova ação preparada por humano.
- O evento `approved` grava `actor_type`/`actor_id` do ator efetivo e metadata
  (`approver_actor_type`, `approver_id`, `approver_source` quando interno,
  `legacy_migration_marker` quando aplicável).
- Bloqueio ocorre antes de qualquer `UPDATE`/`INSERT`: a transação é revertida e
  não existe evento `approved` (testado).

### 8.3 `executeDotActionThroughGateway()` — auditoria dos três eventos

`execution_started`, `executed` e `failed` passaram a gravar
`actorType`/`actorId` do ator efetivo:

- usuário → `actor_type='user'`, `actor_id=<userId do token>`;
- interno → `actor_type='dot'`, `actor_id=NULL`, metadata `actor_source`.

A auditoria de `failed` continua **fora** da transação revertida, com `phase`,
`rolled_back: true` e a mensagem original preservada (a exceção não é mascarada).

### 8.4 Rotas HTTP — identidade exclusivamente do token

`routes/dotRoutes.ts` monta o ator com `dotUserActor(access.userId)`, onde
`access.userId` vem de `resolveDotGate()` (`verifyAccessToken` → `payload.id`).
`actorUserId`, `actor_id`, `approver_id` e `approved_by` do corpo são ignorados
por construção. O teste HTTP de spoofing continua passando (403
`DOT_SEPARATION_OF_DUTIES`).

### 8.5 Atomicidade do follow-up

`createDotFollowUp()` usa a conexão transacional recebida (`database ?? getDb()`,
sem abrir conexão independente quando recebe `tx`); `captureSnapshot` também usa
a conexão injetada. O rollback integral (claim, `execution_started`, caso
interno, follow-up, status final e `executed`) está coberto por testes SQLite e
PostgreSQL.

### 8.6 Testes e resultados reais desta rodada

| Verificação | Resultado real |
|---|---|
| Direcionados: `dotApprovalSeparation`, `dotActionQueue`, `dotExecutionAtomicity`, `dotActionAuditIntegrity`, `dotCoreRegression`, `dot-security-hardening` | **59/59 aprovados**, 0 falhas, 0 ignorados |
| Rotas/missões: `dotRouteProtection`, `dotMissionLifecycle`, `dotAgentMissionRunner` | **21/21 aprovados**, 0 falhas, 0 ignorados |
| Suíte PostgreSQL completa (`node scripts/run-tests.mjs --postgres`) em PostgreSQL 17.11 real, `postgresql://postgres@127.0.0.1:55433/filtra_dot_test` | **22/22 aprovados**, 0 falhas, 0 ignorados |
| Suíte SQLite completa (`node scripts/run-tests.mjs`) | **324/324 aprovados**, 0 falhas, 0 ignorados (0 `skip`) |
| `npm run build` (`tsc --noEmit`) | **0 erros** |
| `npm audit` | **0 vulnerabilidades** |
| `npm audit --omit=dev` | **0 vulnerabilidades** |
| `git diff --check` | **0** |

O cluster PostgreSQL descartável (17.11, porta 55433) foi encerrado ao final; os
testes nunca usaram banco de produção. Cobertura nova inclui: ausência de
`prepared` (SQLite e PostgreSQL), marcador de migração, identidade humana
ausente/inválida, ator interno explícito, autoaprovação, owner override,
preparação pelo Dot + aprovação humana, auditoria dos três eventos com ator
correto, rollback + nova tentativa e concorrência sem efeito duplicado.

### 8.7 Nota de concorrência

Durante parte desta rodada, **outra sessão trabalhou no mesmo worktree**
(`PR139_PRODUCTION_READINESS_REPORT.md` registra o ocorrido; nenhuma alteração
foi descartada). A suíte completa SQLite acima foi executada **de forma
exclusiva**, sem processo de teste concorrente, e o `tsc`/audit/diff-check
rodaram sobre o estado final.

### 8.8 Estado

`HEAD = c9e4a89`, branch `fix/dot-atomicity-sod`; alterações apenas no worktree,
sem commit/push/merge/deploy. Pendências remanescentes: `empresa_owners` é
provisionada por fluxo administrativo (nasce vazia); a tabela de marcadores de
migração nasce vazia (o legado permanece bloqueado até operação deliberada);
retenção/expurgo de auditoria e executor externo/outbox seguem fora do escopo.
