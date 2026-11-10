# Filtra Dot — relatório final de preparação para ativação

> Documento de trabalho. **Nada foi publicado, mergeado, implantado ou ativado**
> por esta revisão: nenhum push, nenhum merge, nenhum deploy, nenhuma migração
> em produção, nenhuma alteração de variável de ambiente.
> Todos os estados abaixo refletem evidência verificada nesta sessão.

## 1. O que foi entregue

**Backend** — worktree `C:\Users\lucas\backend-dot-final`, branch
`feat/dot-production-final` (base `c890c9ae`, o HEAD publicado do PR #144):

| Commit | Conteúdo |
|---|---|
| `52c8ff2` | merge de `origin/feat/dot-http-idempotency` (nenhum trabalho anterior descartado) |
| `7159b83` | failover de provedor preserva o erro final (código/status/mensagem) |
| `07814fd` | drenagem das promises em voo antes de fechar o pool (retry, aquisição, relatório mensal, worker do Dot) |
| `300e4f9` | contrato de idempotência HTTP do chat (serviço, migração, rotas, testes, docs) |
| `09e6b32` | `Idempotency-Replayed`/`Retry-After` expostos ao navegador + logs de requisição ambígua |
| `c8c4792` | documentação: pré-requisito do failover, reconciliação, checklist do Render |

**Frontend** — worktree `C:\Users\lucas\saas-reputacao-ia-dot`, branch
`feat/dot-conversa` (base `cb615991`, o HEAD publicado do PR #203):

| Commit | Conteúdo |
|---|---|
| `e6589c0f` | reescrita da página `/dot/conversa` para o contrato final (chave por mensagem, outbox persistida, códigos novos, failover reabilitado, acessibilidade, correção de contraste) |
| `2fc4566c` | ajuste do texto do estado bloqueado |

## 2. Evidência verificada nesta sessão

### Backend
- `npx tsc --noEmit` → 0 erros.
- `tests/dotHttpIdempotency.test.ts` → 14/14.
- `tests/dotHttpIdempotency.http.test.ts` → 8/8.
- `tests/cors-allowlist.test.ts` → 1/1.
- Grupos DOT (ledger/quota/reserva, shutdown/workers, failover/provedor,
  migrations/schema, segurança/rotas/PIN) → todos verdes.
- Suíte completa em execução local (resultado consolidado na conversa).
- `tests/dotHttpIdempotency.pg.test.ts` → **não executado localmente** (não há
  cluster PostgreSQL nem Docker ativo na máquina); é coberto pelo job
  `postgres-concurrency` do CI.

### Frontend
- `npx tsc --noEmit` → 0 erros; `npx eslint src/app/dot/conversa/page.tsx` → 0
  erros e 0 avisos.
- `npm run build` com `CLOUDFLARE_PAGES=1` (Turbopack, igual ao CI) → verde;
  `/dot/conversa` gerada como página estática; guardrail de idioma do HTML,
  gêmeos Markdown e auditoria de meta descrições → verdes.
- `npm run seo:audit` → PASSED (107 URLs); `npm run seo:markdown:validate` →
  PASSED (106 gêmeos); guardrails de artefato do CI → OK.
- Verificação no navegador (Chromium, export estático servido localmente contra
  uma API simulada que implementa o contrato): envio com sucesso, replay sem
  nova chamada, falha temporária retomada com a **mesma chave**, estado
  ambíguo sem reenvio automático, `DOT_REQUEST_IN_PROGRESS`, `DOT_TOKEN_LIMIT`,
  envio interrompido por reload, descarte de pendência ambígua com confirmação,
  persistência do histórico — sem erros de console.
- Lighthouse na página real: acessibilidade **1.00**, boas práticas **1.00**,
  SEO **1.00**.

## 3. O que continua bloqueando a ativação

1. **Publicar** os commits locais nos dois PRs (push) e esperar o CI verde no
   HEAD final — hoje o CI verde do PR #144 é do `c890c9ae`, não do código novo.
2. **Revisão independente** dos dois diffs (revisor humano autorizado;
   autoaprovação não conta).
3. **Validação da migração** `dot_http_idempotency` em banco descartável/staging
   (a migração falha fechada em schema incompatível).
4. **Confirmar o pré-requisito do failover**: todas as bases de API precisam
   apontar para o mesmo PostgreSQL, senão o failover do chat duplica mensagens.
5. **Autorização explícita** para merge, deploy e `FILTRA_DOT_ENABLED=1`.

## 4. Riscos residuais aceitos

- Linhas `ambiguous`/`failed_safe` não são expurgadas automaticamente (evidência
  de segurança); exigem o procedimento de reconciliação documentado.
- Sem device emulation no navegador: a responsividade foi implementada por
  classes utilitárias, mas não foi medida em viewport móvel.
- O failover do chat continua habilitado porque a segurança depende do ledger
  compartilhado; com bases em bancos distintos, ele deve ser desabilitado.
