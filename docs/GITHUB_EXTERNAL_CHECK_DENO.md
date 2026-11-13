# Check externo `deploy/lu9di/filtra-ai-api-fallback`

> Investigação da Fase 6 da DSV4 Missão 2. Nenhuma proteção de branch, required
> check ou integração foi alterada. A correção proposta é administrativa e
> **não foi executada**.

## 1. O que é

O check não é um GitHub Actions workflow. É um **commit status** publicado pelo
app **Deno Deploy** (contexto `deploy/lu9di/filtra-ai-api-fallback`) no HEAD da
PR #144.

Evidências coletadas via API (2026-11-10):

- `GET /repos/LU9DI/backend/commits/e3ece99.../check-runs` → `test`, `audit`,
  `postgres-concurrency`, todos `completed/success`;
- `GET /repos/LU9DI/backend/commits/e3ece99.../status` → estado agregado
  `failure`, único item:
  `deploy/lu9di/filtra-ai-api-fallback | failure | Organization suspended - resolve billing to deploy`;
- PR #144 `mergeable: true`, `mergeable_state: unstable` — `unstable` decorre
  exclusivamente desse status;
- busca no repositório por `filtra-ai-api-fallback`, `deno` e `deno deploy` em
  workflows, scripts e configuração: nenhuma referência que crie esse status;
- `GET /repos/LU9DI/backend/branches/master/protection` → **404** (branch não
  protegida);
- `GET /repos/LU9DI/backend/rulesets` → **[]** (nenhum ruleset).

## 2. Ele bloqueia o merge?

Tecnicamente **não**:

- não existe required status check configurado (branch protection ausente,
  rulesets vazios);
- a PR é `mergeable: true`;
- os três check runs do CI passam.

Risco real: o estado `unstable` induz a erro humano (parece CI vermelho) e o
status continuará falhando enquanto a integração existir.

## 3. Por que falha

A descrição “Organization suspended - resolve billing to deploy” é emitida pelo
Deno Deploy: a organização/conta Deno está suspensa por cobrança. Não é uma
falha do código nem do pipeline. O alvo de produção é o Render
(`filtra-ia-api`); o caminho Deno é legado.

## 4. Correção recomendada (administrativa)

1. **Preferencial:** desinstalar o app Deno Deploy do repositório
   `LU9DI/backend` (GitHub → Settings → GitHub Apps, ou painel do Deno Deploy →
   projeto → desconectar repositório). Isso interrompe a emissão do status.
2. Alternativa: remover o projeto Deno Deploy associado
   (`lu9di/filtra-ai-api-fallback`) no painel do Deno.
3. Se, e somente se, existir intenção de manter Deno como fallback de deploy:
   regularizar a cobrança da organização Deno.

O que **não** fazer sem autorização explícita: desativar branch protection,
remover required checks, usar `--admin`/bypass, ou marcar o status manualmente
como sucesso (mascararia a origem).

## 5. Estado

- Investigação: concluída.
- Correção: **não executada** (exige acesso de administrador ao GitHub/Deno,
  fora do limite desta missão).
- Enquanto não corrigido, o HEAD da #144 permanecerá `unstable` mesmo com todo
  o CI verde.

## 6. Reconfirmação na DSV4 Missão 3 (2026-11-11)

Verificado novamente no HEAD `5fb46bd4334213938f22ff5232dd6a593d1579e6`:

- `test`, `postgres-concurrency` e `audit`: `completed/success`;
- `GET /commits/<sha>/status` → `failure`, único contexto
  `deploy/lu9di/filtra-ai-api-fallback` com a mesma descrição de organização
  suspensa;
- `branches/master/protection` → 404; `rulesets` → `[]`; `collaborators` →
  somente `LU9DI`; `requested_reviewers` → vazio;
- PR #144 `mergeable: true`, `mergeable_state: unstable`.

**Conclusão:** o check **não é obrigatório** e não bloqueia tecnicamente o
merge; o único efeito é o rótulo `unstable`. Não há API pública do Deno Deploy
acessível sem credenciais da conta para remover o projeto; a solução continua
administrativa (desinstalar o app Deno Deploy do repositório, remover o projeto
legado ou regularizar a cobrança) e **não foi executada**.

Passos administrativos exatos (para quem tiver a permissão):

1. GitHub → repositório `LU9DI/backend` → Settings → GitHub Apps → Deno Deploy
   → Configure → remover acesso ao repositório (ou Uninstall, se for o único);
2. ou Deno Deploy (app.deno.com) → organização `lu9di` → projeto
   `filtra-ai-api-fallback` → Settings → Disconnect GitHub / Delete project;
3. verificar: `gh api repos/LU9DI/backend/commits/<sha>/status --jq .state`
   deve deixar de conter o contexto; o PR passa a `clean` se não houver outro
   status pendente.

Nenhuma proteção de branch, required check ou regra foi alterada nesta missão.
