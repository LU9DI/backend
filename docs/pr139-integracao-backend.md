# PR #139 — Relatório atualizado de integração e validação

> **Repositório:** `LU9DI/backend`
> **PR:** [#139 — fix(dot): make preparation audit atomic and enforce CSRF](https://github.com/LU9DI/backend/pull/139)
> **Branch:** `fix/dot-audit-integrity-postgres` → `master`
> **HEAD funcional revisado:** `ee654f6e115c256ae884afe77994c3ea22f7cadf`
> **HEAD documental atual:** `107f957cfdb041ef5c48af35076738a88d946531`
> **Base:** `b8caf4048f557ce6681b1e08fe66475c7f406d66`
> **Estado:** aberto, não mesclado. Este relatório não autoriza merge nem deploy.

## 1. Estado atual do PR

O HEAD atual do PR é `107f957` (29 commits; 49 arquivos alterados), com base `b8caf404`. O último HEAD funcional revisado é `ee654f6` (28 commits); `107f957` contém apenas a atualização documental deste relatório.

O documento anterior continha informações de uma etapa antiga da integração — commit local `5769919`, patch apenas local, push bloqueado e base `a74c75d`. Essas informações não descrevem mais o estado atual do PR e ficam substituídas por este registro.

## 2. Alterações técnicas presentes no HEAD revisado

- Preparação de ações do Dot registra o usuário autenticado como ator quando a chamada parte de um usuário.
- Criação da ação, atualização da decisão e evento `prepared` são executados na mesma transação.
- Repetição idempotente da preparação não grava um segundo evento `prepared`.
- Aprovação bloqueia as linhas da ação e da decisão no PostgreSQL e grava a auditoria na mesma transação da mudança de estado.
- Migrações centrais incluem a fila e a auditoria de ações; os caminhos de requisição verificam o schema em vez de executar DDL.
- O adapter PostgreSQL mantém transações em um único `PoolClient` e executa migrações sob advisory lock em conexão dedicada.
- O workflow inclui teste de concorrência PostgreSQL com dois processos Node e pools independentes.
- A rota `DELETE /api/dot/admin/session` exige o cabeçalho anti-CSRF.
- A configuração ativa do repositório foi alinhada a Node.js + Render + Supabase; os arquivos/configurações Deno/Jatai foram removidos do código versionado.

## 3. Validação no HEAD funcional `ee654f6`

A execução do HEAD funcional `ee654f6` e as execuções do HEAD documental `107f957` concluíram com sucesso:

| Check | Resultado |
|---|---|
| Backend CI — test (run 199) | **success** |
| Backend CI — postgres-concurrency (run 199) | **success** |
| Dependency audit (run 67) | **success** |
| Backend CI — test + postgres-concurrency (HEAD documental `107f957`, run 200) | **success** |
| Dependency audit (HEAD documental `107f957`) | **success** |

Links das execuções:
- [Backend CI — run 199](https://github.com/LU9DI/backend/actions/runs/41570326775)
- [Dependency audit — run 67](https://github.com/LU9DI/backend/actions/runs/41570326693)
- [Backend CI — HEAD documental `107f957`](https://github.com/LU9DI/backend/actions/runs/41570540985)
- [Dependency audit — HEAD documental `107f957`](https://github.com/LU9DI/backend/actions/runs/41570546117)

A primeira execução após a implementação (`b0bed66`) detectou duas suítes antigas que ainda esperavam o comportamento anterior de devolver a opção já preparada. Os testes foram atualizados para exigir conflito explícito quando a opção solicitada diverge. Na execução seguinte (`ee654f6`), build, suíte unitária/de integração, concorrência PostgreSQL e auditoria de dependências passaram. O status externo Deno continua sendo um status separado e não é um check de CI.

## 4. Status externo de deploy no GitHub

O status `deploy/lu9di/filtra-ai-api-fallback` está como falha e informa:

`Organization suspended - resolve billing to deploy`

A resposta da API do GitHub identifica:
- Criador: `deno-deploy[bot]`.
- URL de destino: `https://console.deno.com/lu9di/filtra-ai-api-fallback`.

**Conclusão da identificação:** esse status é publicado pela integração Deno Deploy e aponta para o console do Deno. Não é um status originado pelo Render. A falha externa não invalida os cinco check-runs do GitHub Actions, mas mantém o status agregado do commit com uma falha externa. A desativação/revogação dessa integração, se desejada, é uma ação administrativa separada no GitHub/Deno e não foi feita nesta revisão.

## 5. Verificação independente do Render

Consulta realizada diretamente no workspace **My Workspace**, no serviço existente:

- Serviço: `filtra-ia-api`
- Repositório: `LU9DI/backend`
- Branch configurada: `master`
- URL: https://filtra-ia-api.onrender.com
- Auto-deploy: habilitado para commits na branch configurada
- Estado consultado: `not_suspended`
- Último deploy listado: `dep-dbk05gqvcj2c73fg7fng`, status `live`
- Commit desse deploy: `b8caf4048f557ce6681b1e08fe66475c7f406d66`
- Build e deploy desse commit: concluídos com sucesso em 02/11/2026.

O histórico do Render registra uma suspensão em 30/10/2026 com o ator `Free Tier Usage Exceeded`, seguida de retomada em 01/11/2026. Na consulta atual, o serviço não está suspenso.

O commit implantado no Render é a base do PR (`b8caf404`), não o HEAD funcional (`ee654f6`). Não há evidência de que o HEAD do PR #139 tenha sido implantado. O status Deno acima não deve ser usado como diagnóstico do deploy Render.

## 6. Revisão técnica — divergência de opção corrigida

Foi corrigido o caso de consistência em `services/dotActionQueue.ts`:

- Repetir a preparação com a mesma opção continua idempotente e devolve a mesma ação ativa.
- Solicitar outra opção enquanto existe uma ação ativa para a decisão lança `DotActionOptionConflictError` (`DOT_ACTION_OPTION_CONFLICT`).
- A rota `POST /api/dot/decisions/:id/prepare-action` converte esse conflito em HTTP `409`, informando a opção já preparada e a opção solicitada.
- A ação original e sua trilha de auditoria permanecem intactas; não é criada uma segunda ação.

Regressões adicionadas/ajustadas em `tests/dotActionAuditIntegrity.test.ts`, `tests/dotActionQueue.test.ts`, `tests/dotCoreRegression.test.ts` e `tests/dotRouteProtection.test.ts`. A suíte completa, o build e o teste de concorrência PostgreSQL passaram no run 199.

## 7. Limites e decisões desta revisão

- PR permanece aberto e sem merge.
- Nenhuma alteração foi feita no serviço, nas variáveis de ambiente, no banco ou na configuração de produção do Render.
- Nenhum deploy foi disparado manualmente.
- Nenhum serviço adicional foi criado.
- Nenhuma integração Deno foi removida ou alterada.
- O novo job PostgreSQL do GitHub Actions usa PostgreSQL efêmero do próprio workflow; não usa Supabase nem dados de produção.

**Próximo gate:** revisão final do diff e decisão humana sobre a integração Deno legada. A correção funcional foi validada; merge e deploy continuam fora do escopo desta execução.
