# PR #139 — Relatório de integração (saas-reputacao-ia → backend)

> **Repositório de destino:** `LU9DI/backend`
> **PR:** #139 • **Branch de destino:** `fix/dot-audit-integrity-postgres`
> **Origem:** `LU9DI/saas-reputacao-ia` • `cline/rf9q7dty` @ `f363c092`
> **Base do destino:** `a74c75d` (histórico do PR preservado, sem merge)
> **SHA local desta integração:** ver `git rev-parse HEAD` (commit de código `5769919`)
>
> **Entrega bloqueada no push:** a conta `cline-cloud[bot]` tem
> `push:false` em `LU9DI/backend` (HTTP 403). Os commits existem apenas no clone
> local e o patch está em `pr139-backend-integration.patch`. Nenhum merge ou
> deploy foi feito. **PR não está pronto para merge.**

## 1. Commits preservados

O histórico do PR foi mantido integralmente; a integração é UM commit novo
sobre `a74c75d`, sem rebase, sem amend e sem substituição de branch:

```
a74c75d test(dot): route approval race to dedicated worker
bd311f5 test(dot): add PostgreSQL approval worker
c59255d test(dot): cover concurrent PostgreSQL approval
ce2e163 test: exclude dedicated PostgreSQL tests from SQLite runner
11b3a1c test(dot): keep PostgreSQL fixture timestamp within integer range
... (histórico anterior do PR preservado)
```

Correções do PR #139 preservadas e cobertas por testes:

- ator autenticado na preparação (`actorUserId ? 'user' : 'dot'`);
- evento `prepared` gravado na MESMA transação da criação da ação;
- deduplicação idempotente sem segundo evento de auditoria;
- `SELECT ... FOR UPDATE` no PostgreSQL (decisão e ação);
- proteção CSRF da sessão administrativa (inalterada);
- testes `dotActionAuditIntegrity`, `dotActionQueue`, `dotActionConcurrency.pg`
  e `dot-security-hardening` verdes.

## 2. Arquivos alterados

```
 lib/db.pg.ts                                 | 230 ++++++++---
 lib/db.ts                                    | 227 ++++-------
 lib/lgpd.ts                                  |  16 +-
 lib/migrations.ts                            | 558 +++++++++++++++++++++++++++
 lib/reviewFraud.ts                           |  21 +-
 mfa.ts                                       |  21 +-
 package-lock.json                            |   6 +-
 package.json                                 |   4 +-
 passwordResetRoutes.ts                       |  41 +-
 routes/adminTecnicoRoutes.ts                 |  11 +-
 routes/empresaRoutes.ts                      |  38 +-
 scripts/run-tests.mjs                        |  19 +-
 scripts/schema-ddl-audit.mjs                 |  71 +++
 services/dotActionAudit.ts                   |  39 +-
 services/dotActionQueue.ts                   |  40 +-
 services/reviewService.ts                    |  16 +-
 services/sentimentBackfill.ts                |  13 +-
 tests/* (14 arquivos novos/ajustados)        | ~1400 +++
 34 files changed, 2595 insertions(+), 411 deletions(-)
```

## 3. Conflitos e decisões de integração

| Tema | Destino (PR #139) | Origem | Decisão |
|---|---|---|---|
| Pool | `let pool` global mutável | pool por instância + lock | portado pool local e `withMigrationLock` |
| Coluna canônica | adapter reescreve `createdAt` → `"createdAt"` | canônico `createdat` no PG | mantido `"createdAt"` (comportamento do adapter do backend); backfill de `createdat`/`created_at` |
| `exec` | engolia 42P07/42701/23505/`already exists` | removeu toda tolerância | mantida tolerância **somente** para comandos com `IF NOT EXISTS` (corrida de catálogo documentada); demais erros propagam |
| `dot_action_queue`/`audit` | DDL em `ensureSchema`/`ensureDotActionAuditSchema` | verificação sem DDL | DDL movida para a migração central; auditoria transacional intacta |
| Auth/MFA | DDL em recuperação de senha/MFA | verificação sem DDL | portado `requireSchema` |
| Runner | já era Node multiplataforma | runner próprio | estendido `scripts/run-tests.mjs` com `--postgres`/`--list` (sem runner duplicado) |
| `initDB` | atribuía `_db` antes das migrações | atômico | mantida lógica Supabase/retry + cleanup e restauração do estado anterior |
| `createdAt` em INSERTs | default da tabela | explícito | `createdAt = CURRENT_TIMESTAMP` nos 3 INSERTs (SQLite legado sem default) |

Nenhuma tabela é recriada; todas as colunas são adicionadas por
`ALTER TABLE ADD COLUMN` após checagem de catálogo/PRAGMA, preservando dados.

## 4. Validação executada

| Comando | Resultado |
|---|---|
| `npm test` | **303/303** (59 suites), 0 falhas/cancelados/skipped |
| `npm run test:postgres` (PostgreSQL 16.15) | **17/17**, 0 falhas |
| `npm run build` (`tsc --noEmit`) | 0 erros |
| `npm audit --omit=dev` | 1 vulnerabilidade moderada **pré-existente** (`@hono/node-server` via MCP; `qs` atualizado via override para 6.17.1) |
| `git diff --check` | sem saídas |

Cenários PostgreSQL cobertos: inicialização concorrente (3 processos),
`PG_POOL_MAX=1`, falha de migração + recuperação, falha não fecha instância
anterior, snapshot real de índices (`pg_indexes`), banco legado com todas as
colunas, backfill/`createdAt` histórico, ausência de DDL em serviços e
concorrência de preparação/aprovação do Dot.

## 5. Auditoria de DDL

`node scripts/schema-ddl-audit.mjs --json`:

- **152 ocorrências em 42 arquivos** fora de `lib/migrations.ts`;
- **0 ocorrências em `reviews`** (grep direto e teste `schemaDdlAudit.test.ts`);
- **0 ocorrências em `dot_action_queue`/`dot_action_audit`**.

As ocorrências restantes são bootstrap idempotente de tabelas de outros
módulos (DOT, pagamentos, relatórios, aquisição, observabilidade). Fora do
escopo desta integração; ficam registradas como dívida técnica e não tocam
`reviews` nem as tabelas de ação/auditoria.

Além da varredura textual, há prova comportamental: com índice/coluna removidos,
`listDotActions`, `recordDotActionAudit` e `listDotActionAudit` falham de forma
explícita e **não recriam** o objeto (teste `dotActionSchemaGuard.pg`).

## 6. Diferenças remanescentes em relação à origem

- Canônico de data é `"createdAt"` (não `createdat`) por causa do `adaptSql`
  deste repositório; backfill e testes foram adaptados.
- Runner de testes é o `scripts/run-tests.mjs` já existente (estendido), em vez
  do runner separado da origem.
- DDL lazy dos demais módulos não foi centralizada (documentada acima).
- Vulnerabilidade moderada de `@hono/node-server` é pré-existente e exige
  upgrade do MCP (não executado para não alterar API neste PR).

## 7. Confirmações

- Sem merge, sem deploy, sem publicação, sem alteração de Render/Supabase/env.
- Nenhuma flag do Filtra Dot foi ativada.
- `main`/`master` do destino intocada; histórico do PR #139 preservado.
- **PR #139 não está pronto para merge**: integração pendente de revisão
  independente e de permissão de push (`cline-cloud[bot]` sem `push` no
  repositório de destino).
