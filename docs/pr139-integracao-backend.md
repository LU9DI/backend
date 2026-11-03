# PR #139 — Relatório atualizado de integração e validação

> **Repositório:** `LU9DI/backend`
> **PR:** [#139 — fix(dot): make preparation audit atomic and enforce CSRF](https://github.com/LU9DI/backend/pull/139)
> **Branch:** `fix/dot-audit-integrity-postgres` → `master`
> **HEAD de código revisado:** `510ddc015cc2ed1db9eed7153a995ea252c82c50`
> **Base:** `b8caf4048f557ce6681b1e08fe66475c7f406d66`
> **Estado:** aberto, não mesclado. Este relatório não autoriza merge nem deploy.

## 1. Estado atual do PR

O código funcional foi revisado no SHA `510ddc0` (20 commits; 49 arquivos alterados). Este relatório foi atualizado em um commit documental posterior, que agora é a ponta do PR. A base do PR permanece `b8caf404`. Os checks do novo HEAD documental ainda precisam ser confirmados.

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

## 3. Validação no commit de código `510ddc0`

Os cinco check-runs retornados pelo GitHub para esse SHA estavam concluídos com sucesso:

| Check | Resultado |
|---|---|
| Backend CI — test (run 184) | **success** |
| Backend CI — postgres-concurrency (run 184) | **success** |
| Dependency audit (run 60) | **success** |
| Backend CI — test (execução anterior do mesmo SHA) | **success** |
| Backend CI — postgres-concurrency (execução anterior do mesmo SHA) | **success** |

Workflows consultados:
- Backend CI: run `41568680321` (e execução anterior `41568675473`).
- Dependency audit: run `41568680076`.

Os resultados acima pertencem ao SHA de código `510ddc0`. A atualização deste próprio documento gera um novo commit e, portanto, exige nova confirmação dos checks no novo HEAD antes de qualquer decisão posterior.

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

O commit implantado no Render é a base do PR (`b8caf404`), não o HEAD do PR (`510ddc0`). Não há evidência de que o HEAD do PR #139 tenha sido implantado. O status Deno acima não deve ser usado como diagnóstico do deploy Render.

## 6. Revisão técnica — item pendente

Foi identificado um caso de consistência funcional em `services/dotActionQueue.ts`:

- `prepareDotActionFromDecision` procura uma ação ativa apenas por empresa e decisão.
- Se já existir uma ação preparada para `optionId=A`, uma nova chamada para a mesma decisão com `optionId=B` retorna a ação A como se a solicitação B tivesse sido atendida.
- A decisão pode conter mais de uma opção; o teste de proteção de rota usa `opcao_1` e `opcao_2`.

A idempotência deve preservar a mesma opção solicitada. Para opção diferente, o serviço deve responder com conflito/resultado explícito em vez de devolver silenciosamente outra opção. Falta adicionar um teste de regressão para esse cenário e decidir o contrato HTTP correspondente.

Esse item não é um problema de CI nem de deploy. Ele deve ser resolvido e validado antes de considerar a revisão funcional concluída.

## 7. Limites e decisões desta revisão

- PR permanece aberto e sem merge.
- Nenhuma alteração foi feita no serviço, nas variáveis de ambiente, no banco ou na configuração de produção do Render.
- Nenhum deploy foi disparado manualmente.
- Nenhum serviço adicional foi criado.
- Nenhuma integração Deno foi removida ou alterada.
- O novo job PostgreSQL do GitHub Actions usa PostgreSQL efêmero do próprio workflow; não usa Supabase nem dados de produção.

**Próximo gate:** corrigir/testar a divergência entre a opção solicitada e a ação ativa retornada; confirmar novamente os checks no HEAD após este commit documental; só então concluir a revisão do PR. Merge e deploy continuam fora do escopo.
