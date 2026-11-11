# Filtra Dot — checklist de ativação no Render (backend) e no frontend

**Status:** preparado, **não aplicado**. Nenhuma variável de produção foi
alterada, nenhuma migração foi executada em produção e nenhum deploy foi feito
por esta revisão.

Este checklist existe para que a ativação seja um ato explícito, auditável e
reversível. Ele pressupõe:

- backend PR #144 (branch `reconcile/dot-production-2026-11-06`) aprovado e
  mergeado em `master`;
- frontend PR #203 (branch `feat/filtra-dot-conversation`) aprovado e mergeado
  em `main`, com a página `/dot/conversa` publicada;
- revisão independente concluída nos dois PRs;
- CI verde no HEAD final de cada PR (incluindo o job `postgres-concurrency`).

## 0. O que foi e o que não foi verificado (2026-11-10)

Verificado a partir do repositório/ambiente local:

- serviço alvo conhecido: `filtra-ia-api` (`srv-dafc88ad0e5s73bqgfm0`),
  `https://filtra-ia-api.onrender.com`, health `/api/live`;
- flags e comportamento de boot conferidos no código (`server.ts`,
  `dotRuntimeEnabled`; Dot desligado por padrão).

**NÃO verificado** (sem acesso): painel do Render, `autoDeploy`, branch
deployada, Dockerfile/build-start usados pelo serviço, variáveis de ambiente
reais, CORS, região/plano/recursos, logs do serviço, health real em produção e
histórico de deploys. Nenhuma chamada à API do Render foi feita.

Acessos necessários para completar a inspeção (sem alterar nada):

1. conta Render com permissão de leitura no time dono de
   `srv-dafc88ad0e5s73bqgfm0` — ou API key com escopos de leitura de
   serviço/deploy;
2. acesso de leitura ao projeto Supabase de produção (schema, backups/PITR);
3. permissão de administrador no GitHub `LU9DI/backend` para tratar a
   integração Deno Deploy (seção de check externo do relatório);
4. janela aprovada para backup e migração (execução futura, fora desta missão).

---

## 1. Antes de tocar em produção

- [ ] Confirmar backup/PITR do PostgreSQL de produção e a janela aprovada.
- [ ] Confirmar que **todas** as bases de API do failover
      (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_API_URL_BACKUP`,
      `NEXT_PUBLIC_API_URLS`, Worker do Cloudflare) usam o **mesmo**
      `DATABASE_URL`. Sem isso, o failover do chat duplica mensagens
      (ver `DOT_PRODUCTION_READINESS.md` §2.4).
- [ ] Confirmar que o frontend publicado envia `X-Dot-Csrf: 1` e
      `X-Idempotency-Key` em `POST /api/dot/chat`.
- [ ] Confirmar as chaves de provedor no serviço do Render:
      `GROQ_API_KEY`, `GEMINI_API_KEY`, `AI_PROVIDER_ORDER`, `GROQ_MODEL`,
      `GEMINI_MODEL`.
- [ ] Confirmar `CORS_ORIGINS` (ou `APP_URL`/`FRONTEND_URL`) com as origens
      reais do frontend — o backend só aceita origens da allowlist.
- [ ] Confirmar `JWT_SECRET` forte e `DATABASE_URL` (PostgreSQL) do serviço.

## 2. Deploy do backend (sem ativar o Dot)

O boot executa `runCentralMigrations` (advisory lock) e cria
`dot_http_idempotency` + `ux_dot_http_idempotency_empresa_key`. A migração
falha fechada se o schema existente for incompatível (ex.: coluna legada
`tenant_id`): o serviço não sobe e o log aponta a reconciliação manual.

Manter **desligado** no primeiro deploy:

```text
FILTRA_DOT_ENABLED      (ausente)
FILTRA_DOT_FORCE_ON     (ausente)
DOT_AGENT_WORKER_ENABLED=0
DOT_DEMO_MODE           (ausente)
```

Validação do deploy (sem Dot):

```bash
curl -sS "$API/api/health"
curl -sS -o /dev/null -w '%{http_code}\n' "$API/api/dot/status"   # esperado: 404
```

Conferir no log do Render:

```text
Schema inicializado (migrações centrais idempotentes)
```

## 3. Ativação do Dot (primeira etapa)

```text
FILTRA_DOT_ENABLED=1
DOT_AGENT_WORKER_ENABLED=0
FILTRA_DOT_FORCE_ON=<ausente>
```

Reiniciar o serviço e validar:

```bash
curl -sS "$API/api/dot/status" | jq '{ok, enabled, access, plan}'
```

## 4. Prova de idempotência no ar (empresa piloto)

Executar com o token de uma empresa piloto e **a mesma** chave nas duas
chamadas. A segunda tem de devolver exatamente o mesmo corpo, sem nova
cobrança:

```bash
KEY=$(uuidgen)
BODY='{"message":"Qual a tendencia da minha reputacao?","session_id":"smoke-1"}'

curl -sS -D- -X POST "$API/api/dot/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'X-Dot-Csrf: 1' \
  -H "X-Idempotency-Key: $KEY" \
  -d "$BODY" | tee /tmp/dot-first.json

curl -sS -D- -X POST "$API/api/dot/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'X-Dot-Csrf: 1' \
  -H "X-Idempotency-Key: $KEY" \
  -d "$BODY" | tee /tmp/dot-second.json
```

Esperado na segunda chamada: header `Idempotency-Replayed: true` e corpo
idêntico ao primeiro.

Verificações complementares:

| Cenário | Esperado |
|---|---|
| sem `X-Idempotency-Key` | HTTP 400 `DOT_IDEMPOTENCY_KEY_REQUIRED` |
| chave malformada | HTTP 400 `DOT_IDEMPOTENCY_KEY_INVALID` |
| mesma chave, outro texto | HTTP 409 `DOT_IDEMPOTENCY_KEY_REUSED` |
| duas chamadas simultâneas | uma 200 e as demais 409 `DOT_REQUEST_IN_PROGRESS` |
| chamada com chave repetida após sucesso | replay (sem nova reserva/`ai_usage`) |

No banco, após o smoke:

```sql
SELECT id, status, response_status, created_at, completed_at
  FROM dot_http_idempotency
 ORDER BY id DESC LIMIT 10;

SELECT count(*) FROM dot_budget_reservations WHERE empresa_id = '<empresa-piloto>';
SELECT count(*) FROM ai_usage WHERE empresa_id = '<empresa-piloto>' AND feature = 'dot';
```

O número de reservas/consumo não pode subir com a repetição da mesma chave.

## 5. Etapas seguintes (uma por vez)

1. `DOT_AGENT_WORKER_ENABLED=1` e observar uma missão completa sem chamada
   externa.
2. Só depois de uma rodada manual aprovada: `FILTRA_DOT_FORCE_ON=1`.
3. Manter desligado: CRM/WhatsApp/e-mail externos (dependem de outbox/worker
   idempotente ainda não implementado).

## 6. Rollback

| Ação | Efeito |
|---|---|
| remover `FILTRA_DOT_ENABLED` e reiniciar | recolhe as rotas do Dot; mantém os dados |
| `DOT_AGENT_WORKER_ENABLED=0` e reiniciar | para o worker de missões |
| remover `FILTRA_DOT_FORCE_ON` e reiniciar | para somente o monitor global |
| restaurar backup PostgreSQL | recuperação de desastre; exige aprovação e janela |

Nenhum rollback apaga reservas, consumos, auditoria ou linhas de idempotência.

## 7. Observabilidade durante a ativação

- `/api/metrics` (com `X-Metrics-Token`) para contadores, scheduler e worker;
- logs JSON por evento com `request_id`/`empresa_id`;
- catálogo de alertas recomendados (nenhum ativo) em
  `DOT_OBSERVABILITY_ALERTS.md`;
- `[dot-idempotency] requisição ambígua (reconciliação necessária)`
- `[dot-idempotency] lease expirado promovido para ambíguo`
- `[dot-idempotency] falha ao persistir resposta`
- consulta de acompanhamento e procedimento de reconciliação em
  `DOT_PRODUCTION_READINESS.md` §2.5.

## 8. Checklist de frontend (publicação)

- [ ] `NEXT_PUBLIC_API_URL` do build aponta para a API do Render que valida a
      idempotência (não para um host antigo ou para um banco distinto).
- [ ] `NEXT_PUBLIC_API_URL_BACKUP`/`_URLS` vazios enquanto o requisito de banco
      compartilhado não for confirmado.
- [ ] Página `/dot/conversa` acessível para empresa dos planos `rei` e
      `corporativo` e bloqueada (com mensagem clara) para os demais.
- [ ] Histórico e mensagem pendente sobrevivem a recarregar a página.
