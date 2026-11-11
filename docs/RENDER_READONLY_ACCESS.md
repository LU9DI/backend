# Render — inspeção somente leitura do serviço `filtra-ia-api`

> **Nenhuma alteração foi feita.** Não havia API key, CLI ou sessão autorizada do
> Render neste ambiente; a inspeção de painel/configuração interna continua
> **pendente de acesso**. O que segue foi verificado por HTTP público (leitura).

## 1. Identificação

| Item | Valor |
|---|---|
| Serviço | `filtra-ia-api` |
| ID | `srv-dafc88ad0e5s73bqgfm0` |
| URL | `https://filtra-ia-api.onrender.com` |
| Health usado pela plataforma | `/api/live` (informado para o serviço) |

## 2. Verificado por leitura pública (2026-11-11)

| Endpoint | Resultado | Leitura |
|---|---|---|
| `/api/live` | 200, `{ok:true, live:true}` | processo vivo; `started_at=2026-11-11T20:34:05Z` |
| `/api/ready` | 200, `{ok:true, db:{ok:true, engine:postgres}}` | banco Postgres acessível |
| `/api/health` | 200; `db_ok:true`; `ai:true` (`groq`,`gemini`); **sem bloco `dot`** | build implantado é **anterior** ao PR #144 |
| `/api/dot/status` | **200** com `enabled:false`, `access:false`, corpo completo | rota existe no build antigo; no PR ela é 403/404 quando desligado |
| `/api/metrics` sem token / token errado | **401** | proteção por `METRICS_TOKEN`/`JOBS_SECRET` ativa |
| Preflight CORS `Origin: https://filtraai.com` | 204 com `access-control-allow-origin: https://filtraai.com` | origem permitida |
| Preflight CORS `Origin: https://evil.example` | 404 sem `access-control-allow-origin` | allowlist rejeitando origem desconhecida |

Observações relevantes:

- O processo reiniciou em `2026-11-11T20:34:05Z` (o `/api/live` expõe
  `started_at`). **Não foi possível atribuir a causa** (deploy, restart da
  plataforma ou OOM) sem o histórico de deploys. O código implantado **não** é o
  HEAD do PR #144: falta o bloco `dot` em `/api/health`, que o PR adiciona.
  Nenhum deploy foi solicitado por esta missão.
- No build atual, os timers do scheduler e do worker estão **ativos**
  (`timer_active:true`) enquanto o Dot aparece como `enabled:false`. O scheduler
  roda a cada 300 s com `companies_processed=0`/`errors=0` nas leituras feitas.
  No PR, scheduler/worker só iniciam com `FILTRA_DOT_ENABLED=1` (fail-closed).
- `/api/dot/status` é público e retorna 200 no build atual; o PR passa a
  responder 403 (desligado) ou 503 (ledger inválido), conforme `server.ts`.

## 3. Não verificado (exige acesso)

- branch conectada e `autoDeploy` (manual x automático);
- build command / start command / Dockerfile x Nixpacks efetivamente usados;
- `healthCheckPath` configurado e política de restart;
- **nomes** e valores de variáveis de ambiente (`CORS_ORIGINS`, `APP_URL`,
  `FRONTEND_URL`, `DATABASE_URL`, `JWT_SECRET`, `GROQ_API_KEY`,
  `GEMINI_API_KEY`, `METRICS_TOKEN`/`JOBS_SECRET`, flags do Dot);
- região, plano, instâncias, disco e auto-scaling;
- logs do serviço e histórico de deploys (inclusive o restart de 20:34Z);
- domínio customizado/TLS e headers aplicados pela plataforma.

## 4. Acessos necessários

1. conta Render com permissão de **leitura** no time dono de
   `srv-dafc88ad0e5s73bqgfm0`; ou
2. API key com escopo de leitura de serviços/deploys, usada apenas em runtime
   (`RENDER_API_KEY`), nunca em commit;
3. janela aprovada para qualquer alteração (fora desta missão).

## 5. Consultas somente leitura para executar quando houver acesso

```bash
# serviço (branch, autoDeploy, região, plano, health check)
curl -sS -H "Authorization: Bearer $RENDER_API_KEY" \
  https://api.render.com/v1/services/srv-dafc88ad0e5s73bqgfm0

# deploys recentes (causa do restart de 20:34Z)
curl -sS -H "Authorization: Bearer $RENDER_API_KEY" \
  'https://api.render.com/v1/services/srv-dafc88ad0e5s73bqgfm0/deploys?limit=10'

# nomes das variáveis (mascarar valores ao registrar evidência)
curl -sS -H "Authorization: Bearer $RENDER_API_KEY" \
  https://api.render.com/v1/services/srv-dafc88ad0e5s73bqgfm0/env-vars

# instâncias e eventos
curl -sS -H "Authorization: Bearer $RENDER_API_KEY" \
  https://api.render.com/v1/services/srv-dafc88ad0e5s73bqgfm0/instances
```

Checklist do que confirmar nesta ordem: branch = `master` (ou a branch de
release definida), `autoDeploy` consciente, start `npm start` (ou Dockerfile),
`healthCheckPath=/api/live`, `CORS_ORIGINS` contendo apenas as origens reais,
`DATABASE_URL` do Supabase de produção, flags do Dot ausentes/desligadas,
`METRICS_TOKEN` definido, versão implantada = commit aprovado.

## 6. Situação

- Inspeção pública: concluída.
- Inspeção de painel/configuração: **bloqueada por falta de acesso**.
- Alterações em produção: **nenhuma**.
