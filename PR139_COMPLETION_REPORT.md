# PR #139 — Relatório de conclusão: execução atômica e separação de funções

**Repositório:** `LU9DI/backend`
**PR:** https://github.com/LU9DI/backend/pull/139
**Branch de destino do PR:** `fix/dot-audit-integrity-postgres`
**Base do PR (remota):** `3f584ebab8441aa9eec6fcedcbe5d520ab0447aa` (`3f584eb`)
**Worktree isolado desta continuação:** `C:\Users\lucas\backend-pr139-atomicity`
**Branch local:** `fix/dot-atomicity-sod`
**Commit local da implementação:** `a4c4ba93012205dea3b381c6d5c61166cf2c2317`
**Data:** 2026-11-03 (America/Sao_Paulo)

> **Commit/push realizados na branch da PR; nenhum merge ou deploy foi executado.**
> A branch `master` não foi alterada. O trabalho está no worktree e no branch da PR.

---

## 1. Resultado da recuperação do commit original

O commit `c138619` (`fix(dot): execução interna atômica e separação entre preparador e aprovador`) **não foi recuperado**. A busca foi feita sem modificar os clones:

- `git cat-file -t c138619` → objeto inexistente em `backend`, `backend-dot-audit`, `backend-pr139-integration` e `wt-dot-owner`;
- `git log --all`, reflogs e `git fsck --unreachable` dos clones da PR não contêm o commit;
- o clone principal `C:\Users\lucas\backend` tem 352 commits inalcançáveis, todos de setembro/outubro e sem relação com este commit; `git log -S'DotApprovalSeparationError'`/`DOT_SEPARATION_OF_DUTIES` não encontrou nada;
- o bundle de preservação `C:\Users\lucas\Desktop\PR139-preservacao-20261102.bundle` lista **apenas** `refs/heads/fix/dot-audit-integrity-postgres` em `510ddc0`;
- não existe `pr139-atomicity-sod.patch` (nem `.diff`) nos diretórios de clones, worktrees, `Downloads`, `Desktop`, `Documents`, `work` ou `AppData\Local\Temp\opencode`; os únicos artefatos PR139 encontrados são logs da validação PostgreSQL anterior;
- a branch remota do PR tinha `3f584eb` (mais nova que `510ddc0`), mas o histórico `510ddc0..3f584eb` contém apenas correções de opção/CI e `fix(dot): allow internal execution within transaction`, não a implementação perdida.

**Conclusão:** o trabalho original não existe em nenhum objeto Git recuperável neste ambiente. A implementação abaixo é uma **reconstrução equivalente**, sem atribuir a ela o hash ou a autoria de `c138619`.

O que foi preservado:
- bundle original no Desktop, intocado;
- clones e worktrees originais (o clone `backend-pr139-integration` foi devolvido à branch `fix/dot-audit-integrity-postgres` em `510ddc0` após a inspeção);
- `backend-dot-audit` em `076ceb4`, sem alterações;
- `backend` principal, sem alterações.

---

## 2. Base utilizada

A base escolhida foi o **HEAD remoto atual da PR, `3f584eb`**, porque:

- é o topo real de `refs/heads/fix/dot-audit-integrity-postgres` e de `refs/pull/139/head`;
- contém o trabalho de integridade PostgreSQL já validado (advisory lock, isolamento de pools, erros de catálogo, placeholders, migrações centrais);
- contém o modelo de propriedade `empresa_owners` e a proteção administrativa do Dot que a separação de funções precisa usar;
- `510ddc0` (clone local) estava desatualizado em relação ao remoto.

O worktree foi criado a partir de `3f584eb` com `node_modules` compartilhado por junction com o clone de integração (mesmo `package-lock.json`; nenhuma instalação nova).

---

## 3. Alterações realizadas

### 3.1 Execução atômica

`services/dotExecutionGateway.ts` foi reescrito para executar em **uma única transação**:

1. reler a ação `approved` e a decisão `approved/requires_approval=1`;
2. claim condicional `UPDATE dot_action_queue SET status='executing' WHERE status='approved'`;
3. auditoria `execution_started` na mesma conexão;
4. executar a ação interna (`executeDotInternalAction(..., tx)`);
5. criar o follow-up (`createDotFollowUp(..., tx)`);
6. atualizar para `executed`;
7. auditoria `executed`;
8. **um único COMMIT**.

Qualquer falha antes do COMMIT faz ROLLBACK integral: claim, `execution_started`, caso interno, follow-up, status final e auditoria de sucesso desaparecem juntos. A ação volta a `approved`, permanecendo retentável. A falha é registrada **fora** da transação com `phase`, `rolled_back: true` e a mensagem original, sem mascarar a exceção.

DDL/schema checks ocorrem **antes** da transação, via `requireSchema` (sem DDL em caminho de requisição). Não há chamadas externas dentro da transação; os executores atuais são internos. Se um executor externo for adicionado, será necessário outbox/worker idempotente (registrado como pendência).

### 3.2 Separação de funções

`services/dotActionQueue.ts` → `approveDotAction`:

- identifica o preparador pela trilha auditável (`dot_action_audit` com `event='prepared'`), nunca por payload do cliente;
- bloqueia mesmo usuário como preparador e aprovador;
- erro `DotApprovalSeparationError`, `code = 'DOT_SEPARATION_OF_DUTIES'`, `status = 403`;
- exceção somente para o **owner autoritativo** verificado em `empresa_owners` (query dentro da mesma transação);
- registra no evento `approved` o metadata:
  - `separation_decision`: `distinct_actors` | `owner_override` | `no_preparer_recorded` | `internal_actor`;
  - `owner_override`, `preparer_id`, `preparer_actor_type`, `approver_id`.
- O rollback em caso de bloqueio preserva ação/decisão em `prepared` e não grava evento `approved`.

`routes/dotRoutes.ts` mapeia a exceção para **HTTP 403** com `{ ok:false, code:'DOT_SEPARATION_OF_DUTIES' }`; o teste HTTP cobre isso.

### 3.3 Schema centralizado (sem DDL na execução)

- `lib/migrations.ts` passou a criar/verificar `dot_internal_cases`, `dot_followups`, `dot_events`, `empresa_owners` e seus índices, de forma idempotente (SQLite e PostgreSQL).
- `services/dotFollowUp.ts`, `services/dotInternalExecutors.ts` e `services/dotActionAudit.ts` não executam mais `CREATE/ALTER` em requisição; usam `requireSchema`/`recordDotActionAudit(input, tx)`.
- `createDotFollowUp` e `recordDotActionAudit` aceitam conexão/transação injetada e não abrem conexão independente quando recebem `tx`.

### 3.4 Arquivos

**Modificados**
- `lib/migrations.ts`
- `routes/dotRoutes.ts`
- `services/dotActionAudit.ts`
- `services/dotActionQueue.ts`
- `services/dotExecutionGateway.ts`
- `services/dotFollowUp.ts`
- `services/dotInternalExecutors.ts`
- `tests/dotRouteProtection.test.ts`

**Novos**
- `tests/dotExecutionAtomicity.test.ts`
- `tests/dotExecutionAtomicity.pg.test.ts`
- `tests/dotApprovalSeparation.test.ts`
- `PR139_COMPLETION_REPORT.md`

---

## 4. Garantias de atomicidade

- Claim atômico com `WHERE status='approved'`; `changes === 1` obrigatório.
- `execution_started`, caso interno, follow-up, `executed` e auditoria final na mesma transação/conexão.
- Falha em qualquer etapa → rollback total; nenhum efeito parcial.
- Falha registrada fora da transação, com fase e `rolled_back`, sem esconder o erro original.
- Duas execuções concorrentes → exatamente uma vence; sem caso/follow-up/auditoria duplicados.
- Replay após commit → não executa de novo.
- Testes SQLite e PostgreSQL real cobrem sucesso, falha no follow-up, concorrência e retry.

## 5. Garantias de separação de funções

- Preparador vem do histórico auditável; não de campo do cliente.
- Mesmo usuário sem ser owner → `DOT_SEPARATION_OF_DUTIES`, HTTP 403, rollback.
- Owner verificado em `empresa_owners` → `owner_override` auditado.
- Preparação automática (`actor_type='dot'`) → `internal_actor`.
- Ausência de preparador registrado → `no_preparer_recorded`.
- Aprovador distinto → `distinct_actors`.
- Testes SQLite + PostgreSQL + HTTP cobrem todos os casos.

---

## 6. Testes executados e resultados

### 6.1 Suíte completa SQLite

Comando:
```powershell
cd C:\Users\lucas\backend-pr139-atomicity
$env:NODE_ENV='test'
npm test
```

Resultado registrado: **327 testes, 327 aprovados, 0 falhas, 0 ignorados, 0 cancelados** (CI Node 20), incluindo atomicidade, SoD, contrato de auditoria, CSRF dedicado, spoofing HTTP, isolamento e retenção auditada.

### 6.2 Suíte PostgreSQL real

Cluster descartável local `PostgreSQL 17.11` em `127.0.0.1:55433`, banco `filtra_dot_test` (trust local, sem dados de produção):

```powershell
$env:DATABASE_URL='postgresql://postgres@127.0.0.1:55433/filtra_dot_test'
$env:NODE_ENV='test'
npm run test:postgres
```

Resultado registrado: **22 testes, 22 aprovados, 0 falhas, 0 ignorados, 0 cancelados** — testes PostgreSQL da PR, incluindo concorrência e atomicidade.

### 6.3 Teste de CI `dotMonitorIsTest.test.ts`

O teste foi mantido; não foi removido nem mascarado. A causa provável do flake foi corrigida no próprio teste: `initDB()` era chamado várias vezes sem fechar a instância anterior, deixando handles SQLite abertos, e os bancos usavam caminhos fixos em `/tmp`. O teste agora usa diretório temporário único, `closeDB()` antes de trocar/reabrir e hook `after` para fechar/limpar.

Execução isolada após a correção:

- Node 20.20.2: **3 execuções consecutivas, 3/3 aprovados em todas**;
- Node 26.7.0: **3/3 aprovados**.

O erro literal de CI (`Unable to deserialize cloned data`) não foi reproduzido neste ambiente; o CI GitHub ainda precisa ser executado após o push. Referências do flake conhecido do runner: https://github.com/nodejs/node/issues/64061, https://github.com/nodejs/node/issues/66164, https://github.com/nodejs/node/issues/56802.

### 6.4 TypeScript / build / diff

- `npx tsc --noEmit` → **0 erros**;
- `npm run build` (tsc) → **0 erros**;
- `git diff --check` → **0** (sem whitespace/conflito).

### 6.5 Auditoria de dependências

A vulnerabilidade moderada pré-existente em `@hono/node-server` (GHSA-rmxm-3fg6-px4f) foi corrigida na preparação de produção: override para `@hono/node-server@2.1.6`, versão estável corrigida permitida por `@modelcontextprotocol/node@2.1.2`. Depois da correção: `npm audit` e `npm audit --omit=dev` → **0 vulnerabilidades**. Detalhes em `PR139_PRODUCTION_READINESS_REPORT.md`.

### 6.6 Validação final (2026-11-03)

Execução final no worktree, sem commit:

- suíte SQLite completa: **327/327 aprovados**, 0 falhas, 0 ignorados (CI);
- suíte PostgreSQL completa em cluster descartável PostgreSQL 17.11: **22/22 aprovados**, 0 falhas, 0 ignorados;
- testes direcionados (atomicidade, rollback, follow-up, retry, contrato `dot`, SoD, owner override, spoofing HTTP, isolamento): **47/47 aprovados**;
- `npm run build` (`tsc --noEmit`): **0 erros**;
- `npm audit` e `npm audit --omit=dev`: **0 vulnerabilidades** após override de `@hono/node-server` para `2.1.6`;
- `git diff --check`: **0**.


---

## 7. Estado do Git

| Item | Estado |
|---|---|
| Base do PR (remota) | `3f584eb` |
| Worktree desta entrega | `C:\Users\lucas\backend-pr139-atomicity` |
| Branch local | `fix/dot-atomicity-sod` (a partir de `3f584eb`) |
| Commit da implementação | `a4c4ba93012205dea3b381c6d5c61166cf2c2317` |
| Commit deste relatório | o HEAD do worktree após este commit (ver `git log`) |
| Clone `backend-pr139-integration` | restaurado em `fix/dot-audit-integrity-postgres` = `510ddc0` |
| Clone `backend-dot-audit` | `076ceb4`, intocado |
| Clone `backend` principal | intocado |
| Push/merge/deploy | push **realizado** (`4a3bf87`); merge/deploy **não executados** |
| Branch remota | **inalterada** |

O commit local desta entrega consta no histórico do worktree (`git log`). O relatório não altera a branch remota.

---

## 8. Limitações do ambiente

1. **Sem execução no GitHub Actions** desta continuação; os resultados são de execução local comprovada.
2. **PostgreSQL 17.11 local descartável**; suficientes para concorrência/rollback, mas não substituem o serviço de CI do PR.
3. **Flake de CI não reproduzido** em Node 20.20.2/26.7.0.
4. Não há executor externo homologado; o gateway continua rejeitando `externalSideEffect`. Outbox não é necessário hoje, mas será ao habilitar efeito externo.
5. `empresa_owners` nasce vazia; o owner precisa ser provisionado por fluxo administrativo auditado (já existente na PR). Sem owner, a mesma pessoa que preparou não aprova.
6. A ação que falha permanece `approved` para retry; não há contador/backoff de tentativas nesta entrega.

## 9. Pendências e riscos remanescentes

- CI: reexecutar o job para confirmar o flake; se persistir, investigar versão exata do Node no runner (o erro é do IPC do `node:test`).
- Auditoria: `@hono/node-server` moderado pré-existente; tratar em PR de dependências.
- Outbox/executor externo: desenho obrigatório antes de liberar ação externa.
- Backoff/limite de retries de execução: hoje cada falha gera auditoria `failed` e a ação continua retentável.
- `empresa_owners` sem FK/RLS; isolamento é aplicacional, como no restante do PR.
- O worktree usa `node_modules` por junction com o clone de integração; não faz parte do commit.

---

## 10. Comandos para revisão e push (após autorização)

```powershell
cd C:\Users\lucas\backend-pr139-atomicity
git log --oneline -5
git diff 3f584eb..HEAD
git status --short

# Suíte SQLite
$env:NODE_ENV='test'
npm test

# Suíte PostgreSQL (cluster descartável local)
$env:DATABASE_URL='postgresql://postgres@127.0.0.1:55433/filtra_dot_test'
npm run test:postgres

# Push NÃO executado; somente após revisão/autorização:
# git push origin fix/dot-atomicity-sod:fix/dot-audit-integrity-postgres
```

**Nenhum merge e nenhum deploy foram realizados.**

---

## 11. Atualização final (identidade, bloqueio sem `prepared` e auditoria)

> Ver **`PR139_REVIEW_ADDENDUM.md` §8**, que substitui a seção 3.2 deste relatório
> onde ela descrevia `no_preparer_recorded` sem marcador.

- Contrato tipado de ator (`services/dotActor.ts`): usuário autenticado ou ator
  interno autorizado; ausência/identidade inválida é **rejeitada** (nunca vira `dot`).
- Ausência de evento `prepared` **BLOQUEIA** a aprovação; compatibilidade
  histórica apenas com marcador explícito e restrito em
  `dot_action_legacy_approval_markers` por `(empresa_id, action_id)`.
- `execution_started`, `executed` e `failed` auditam o ator efetivo
  (`user/<id>` ou `dot/NULL`), sem usuário anônimo; falha fora da transação
  preserva a exceção original.
- Rotas usam somente a identidade do token validado.
- Validação final real: **327/327 SQLite**, **22/22 PostgreSQL 17.11**,
  **59/59 + 21/21 direcionados**, **build 0**, **audit 0/0**, **diff-check 0**,
  0 testes ignorados.
