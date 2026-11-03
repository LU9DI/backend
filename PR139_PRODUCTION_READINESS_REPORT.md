# PR #139 — Relatório de preparação para produção (rodada final)

**Worktree:** `C:\Users\lucas\backend-pr139-atomicity`
**Branch:** `fix/dot-atomicity-sod`
**Base:** `3f584ebab8441aa9eec6fcedcbe5d520ab0447aa`
**HEAD:** `c9e4a897f432202b7e093f079aa82f794f8d48cf` (inalterado)
**Data:** 2026-11-03

> **Nenhum commit, push, merge ou deploy foi executado.**
> Nenhuma flag do Dot foi ativada. Nenhum ambiente de produção foi alterado.

---

## 1. Resultado executivo

| Item | Estado |
|---|---|
| Vulnerabilidade GHSA-rmxm-3fg6-px4f | **corrigida** (`@hono/node-server@2.1.6`) |
| `npm audit` / `npm audit --omit=dev` | **0 / 0** |
| Build (`tsc --noEmit`) | **0 erros** |
| Suíte SQLite | **327/327 aprovados**, 0 falhas, 0 ignorados |
| Suíte PostgreSQL | **22/22 aprovados**, 0 falhas, 0 ignorados |
| Testes direcionados de SoD/atomicidade/CSRF/spoofing | aprovados (incluídos na suíte) |
| `git diff --check` | **0** |
| CI GitHub (Backend CI/Dependency audit) | **verde**; único check vermelho é `deploy/lu9di/filtra-ai-api-fallback` (deploy Render) por “Organization suspended / billing” (externo) |
| Commit/push | **realizados** no branch da PR (`4c9a781`); sem merge/deploy |

A implementação está tecnicamente pronta para revisão e commit local. A
ativação em produção continua bloqueada pelas pendências externas da seção 8.

---

## 2. Prioridade 1 — correção da dependência

### 2.1 Diagnóstico

```text
backend@1.0.5
`-- @modelcontextprotocol/node@2.1.2
  +-- @hono/node-server@1.19.17
  | `-- hono@4.13.13 deduped
  `-- hono@4.13.13
```

`@modelcontextprotocol/node@2.1.2` declara
`"@hono/node-server": "^1.19.9 || ^2.1.3"`; a linha 2.1.3+ é suportada
oficialmente. `hono@4.13.13` satisfaz o peer `^4`.

### 2.2 Correção

```json
"overrides": {
  "@hono/node-server": "2.1.6"
}
```

Resultado:

```text
@modelcontextprotocol/node@2.1.2
  +-- @hono/node-server@2.1.6 overridden
  | `-- hono@4.13.13 deduped
  `-- hono@4.13.13
```

O `package-lock.json` mudou somente o bloco de `@hono/node-server` (versão,
integridade, engines e peer). Nenhum outro pacote foi atualizado.

### 2.3 Compatibilidade verificada

- `@hono/node-server@2.1.6`: `engines.node >=20`, peer `hono ^4 || ^5.0.0-0`.
- Projeto: `engines.node >=20`; Dockerfile em `node:20-bookworm-slim`.
- Imports validados em Node 20.20.2 e Node 26.7.0:
  `@hono/node-server/serve-static`, `@modelcontextprotocol/node` e SQLite.
- Smoke de inicialização real (SQLite temporário, Dot desligado):
  `/api/health` 503 durante boot → **200** após init; rota inexistente **404**;
  `x-request-id`, `x-content-type-options: nosniff`, `x-frame-options: DENY`;
  `/mcp` 406 sem Accept SSE → **200** com `initialize`; `serve-static` **200**
  servindo arquivo temporário.
- Servidor e banco temporário encerrados/limpos ao final.

---

## 3. CI `dotMonitorIsTest.test.ts`

O erro de CI `Unable to deserialize cloned data due to invalid or unsupported
version` **não foi reproduzido literalmente** neste ambiente, mas o log real do
GitHub Actions foi obtido e confirma a falha:

- workflow `Backend CI`, run `41571463087`, job `test` (falha em 03/11/2026);
- `not ok 29 - .../tests/dotMonitorIsTest.test.ts`
- `failureType: 'uncaughtException'`, `error: 'Unable to deserialize cloned
  data due to invalid or unsupported version.'`, `ERR_TEST_FAILURE`.

A causa provável foi encontrada e corrigida no teste:

- o teste chamava `initDB()` várias vezes com caminhos SQLite diferentes;
- `initDB()` não fecha a instância anterior ao reabrir; handles SQLite ficavam
  abertos (no Windows geravam `EBUSY` na limpeza, e no runner do CI podem
  desestabilizar o processo filho/serialização);
- os bancos usavam caminhos fixos em `/tmp`, sujeitos a colisão/resíduos.

Correções no teste:

- diretório temporário único por processo (`mkdtempSync`);
- `closeDB()` antes de trocar de banco e antes do segundo `initDB()` de
  idempotência;
- hook `after` fecha o banco e remove o diretório;
- nenhuma cobertura removida ou teste ignorado.

Evidência: **Node 20.20.2 → 3 execuções consecutivas, 3/3 aprovados em todas**;
Node 26 → suíte completa aprovada. O CI GitHub foi executado após o push e os
jobs Backend CI/test, postgres-concurrency e Dependency audit passaram; resta
apenas o status externo de deploy Render bloqueado por billing.

---

## 4. CSRF das mutações de empresa

Implementado middleware no início de `mountDotRoutes`:

- toda mutação em `/api/dot/*` exige `X-Dot-Csrf: 1` (ou `true`), **incluindo
  `/api/dot/agent/*`** (goals, missões, run-step, advance, resume, permissões);
- `X-Dot-Admin: 1` é aceito como fallback administrativo (header customizado,
  não forjável por CSRF);
- somente `/api/dot/admin/*` mantém seu gate próprio `X-Dot-Admin`;
- sem header: **403 `DOT_CSRF_REQUIRED`**, antes de autenticar;
- GET/HEAD/OPTIONS permanecem livres;
- o teste cobre também uma mutação de agente sem header.

Também foram removidos os `CREATE TABLE IF NOT EXISTS` remanescentes de
`GET /api/dot/cases` e `POST /api/dot/resolve`; esses endpoints agora usam
`ensureDotInternalActionSchema`/`ensureDotFollowUpSchema` (sem DDL) e as
tabelas vêm das migrações centrais. Um teste estático impede a reintrodução.

A retenção de auditoria ganhou uma CLI manual, dry-run por padrão, com export e
purge confirmado (`DOT_AUDIT_RETENTION_CONFIRM=1`), registrando a própria
operação em `audit_logs`. Não há scheduler nem expurgo automático.

Testes:
- helper HTTP de `dotRouteProtection` e `dotRouting` agora envia
  `X-Dot-Csrf: 1`;
- novo teste prova `403 DOT_CSRF_REQUIRED` sem header, para empresa e agente;
- o teste E2E de spoofing já existente envia `actorUserId`, `actor_id`,
  `approver_id` e `approved_by` no corpo e comprova que o ator continua vindo
  exclusivamente do token, com HTTP 403 `DOT_SEPARATION_OF_DUTIES` no caso do
  próprio preparador.

**Impacto de implantação:** o frontend precisa enviar `X-Dot-Csrf: 1` nas
mutações de empresa. Sem essa atualização, a ativação quebrará preparar,
aprovar, executar, follow-up, eventos e preferências. Documentado no runbook.

---

## 5. Reconciliação do snapshot perdido

O snapshot original `c9e4a89`/commit `c138619` e o ZIP `B3F5…17AA` **não foram
recuperados**. Busca forense:

- `git cat-file`, reflogs, `fsck`, branches/tags e bundle não contêm `c138619`;
- não foi localizado arquivo com hash `B3F5…17AA` neste ambiente;
- há preservações parciais no Desktop:
  - `backend-pr139-atomicity.zip` — SHA-256 `0554CC51…F1100D`;
  - `PR139-forensic.zip` — SHA-256 `375896EB…E599D3`, contendo bundle,
    patches, hashes e untracked do estado intermediário.

Esses backups permitem auditar a evolução, mas **não substituem** o snapshot
original perdido. A entrega atual continua sendo uma reconstrução sobre
`3f584eb`; nenhuma alegação de que o trabalho perdido foi recuperado é feita.

---

## 6. Documentação operacional

- `docs/DOT_PRODUCTION_READINESS.md` — owner, flags, migrações, retenção,
  observabilidade, interno vs. externo.
- `docs/DOT_ACTIVATION_RUNBOOK.md` — runbook de ativação gradual, CSRF,
  validação de staging, kill switch, rollback e critérios de abortar.
- `PR139_COMPLETION_REPORT.md` e `PR139_REVIEW_ADDENDUM.md` atualizados com os
  números finais.

---

## 7. Validação final executada

| Comando | Resultado real |
|---|---|
| `npm test` | **327/327 aprovados**, 0 falhas, 0 ignorados (CI) |
| `npm run test:postgres` | **22/22 aprovados**, 0 falhas, 0 ignorados |
| `npm run build` / `tsc --noEmit` | **0 erros** |
| `npm audit` | **0 vulnerabilidades** |
| `npm audit --omit=dev` | **0 vulnerabilidades** |
| `tests/dotMonitorIsTest.test.ts` no Node 20.20.2 (3x) | **3/3 em cada execução** |
| `git diff --check` | **0** |

PostgreSQL usado: cluster descartável local PostgreSQL 17.11, banco
`filtra_dot_test`; encerrado ao final. Nenhum teste foi ignorado ou cancelado.

### 7.1 Revisão independente

Foi executada uma revisão independente somente leitura do diff. Achados
bloqueadores e altos tratados nesta rodada:

- CSRF das mutações `/api/dot/agent/*`: agora exigido, com teste HTTP;
- DDL em `GET /api/dot/cases` e `POST /api/dot/resolve`: removido; teste
  estático impede reintrodução;
- retenção: CLI auditada com dry-run/export/purge e registro em `audit_logs`;
- novo snapshot de retenção/reconciliação foi incluído na suíte final.

Achados médios remanescentes, documentados como riscos operacionais: catch de
erro de banco dentro de transação pode mascarar diagnóstico em PostgreSQL;
tentativas negadas de SoD/execução não têm evento dedicado; não há TTL/reaper
automático para ação aprovada ou presa em `executing`; marcador legado só tem procedimento
manual documentado. Nenhum deles altera a atomicidade/SoD comprovados, mas
devem ser acompanhados antes de autonomia ampla.

---

## 8. Bloqueadores para produção (externos ao código)

1. **Status externo de deploy Render**: o check
   `deploy/lu9di/filtra-ai-api-fallback` falha com “Organization suspended —
   resolve billing to deploy”. Não é falha de código; Backend CI e Dependency
   audit estão verdes, mas esse status externo precisa ser resolvido.
2. **Revisão humana independente** (a revisão automática independente foi feita
   nesta rodada; commit/push já realizados no branch da PR).
3. **Staging real**: deploy, PostgreSQL gerenciado, backup/migração de boot,
   smoke de preparar/aprovar/executar/acompanhar, falha/rollback, replay e
   isolamento entre empresas.
4. **Render**: serviços reais, branches, env, CORS/domínio, health checks.
5. **Owner real**: provisionamento auditado por empresa piloto; não executado.
6. **Flags**: ativação gradual e kill switch não testados em ambiente real.
7. **Frontend CSRF**: enviar `X-Dot-Csrf: 1` nas mutações de empresa e agente.
8. **Observabilidade**: alertas para `failed`, ação presa em `executing`,
   execução duplicada e erro de scheduler ainda não configurados.
9. **Retenção LGPD**: CLI manual de dry-run/export/purge implementada e
   testada; falta aprovação formal da política e execução do expurgo em
   produção, com backup.
10. **Outbox/worker externo** para CRM/WhatsApp/e-mail/Google não implementado;
    esses canais devem permanecer bloqueados.

## 9. Parecer

**APROVADO COM RESSALVAS** para revisão e merge controlado.

O código está compilando, com auditoria 0/0, CI Backend verde (327/327 SQLite,
22/22 PostgreSQL), CSRF e spoofing cobertos e documentação de ativação criada.
O commit `4a3bf87` foi enviado ao branch da PR (sem merge/deploy). As ressalvas
são de validação externa (staging/Render/Supabase, owner/flags,
observabilidade), atualização do frontend para o header CSRF, aprovação da
retenção, outbox externo e o check externo Render bloqueado por billing.
**A produção permanece bloqueada até essas etapas serem concluídas.**

**Nenhum merge ou deploy foi realizado.**
