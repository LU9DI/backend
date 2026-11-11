# Alertas do Filtra Dot — configuração operacional (A1–A12)

> **Status: preparado, NÃO ativado.** Nenhum canal externo foi conectado, nenhum
> webhook foi cadastrado e nenhum alerta está sendo enviado em produção. A
> ativação depende de credenciais e autorização do responsável pela operação
> (Render/observabilidade), que não estavam disponíveis nesta missão.

Este diretório contém a configuração e o executor dos alertas descritos em
`docs/DOT_OBSERVABILITY_ALERTS.md` §5. O objetivo é que a ativação seja apenas
“apontar o executor para a API e ligar o envio”, sem reescrever regras.

## 1. Arquivos

| Arquivo | Papel |
|---|---|
| `ops/alerts/dot-alerts.json` | limiares e severidades de A1–A12 |
| `lib/dotAlertRules.ts` | regras (avaliação pura, testável) |
| `lib/dotAlertMonitor.ts` | coleta de `/api/metrics` + `/api/health`, payload de webhook |
| `scripts/dot-alert-monitor.ts` | CLI (dry-run por padrão, daemon ou execução única) |
| `tests/dotAlertRules.test.ts` | 27 testes: cada alerta, aquecimento, reinício, token, webhook |

## 2. Fonte de dados e autenticação

- `GET /api/metrics` — contadores monotônicos, rotas/latência e estado do
  scheduler/worker. Em produção exige `X-Metrics-Token: $METRICS_TOKEN`
  (ou `X-Jobs-Secret: $JOBS_SECRET`).
- `GET /api/health` — público; `ok`/`db_ok` e booleanos do Dot. Responde 503
  com corpo quando o banco está fora, e o coletor lê o corpo mesmo assim.

O token é usado apenas no header da requisição. Ele **não** entra em log, em
mensagem de erro, no payload do webhook nem nos alertas.

## 3. Como executar

Dry-run (não envia nada; imprime um JSON por alerta e sai com 0):

```bash
cd backend
DOT_ALERT_BASE_URL="$API" METRICS_TOKEN="$TOKEN" \
  npx tsx scripts/dot-alert-monitor.ts --once
```

Daemon (recomendado para janelas corretas; um processo contínuo):

```bash
DOT_ALERT_BASE_URL="$API" METRICS_TOKEN="$TOKEN" \
DOT_ALERT_WEBHOOK_URL="$WEBHOOK" \
  npx tsx scripts/dot-alert-monitor.ts --interval 60 --send
```

Uma execução por cron (o estado fica em arquivo; use um caminho fora do repo):

```bash
DOT_ALERT_BASE_URL="$API" METRICS_TOKEN="$TOKEN" \
DOT_ALERT_WEBHOOK_URL="$WEBHOOK" \
  npx tsx scripts/dot-alert-monitor.ts --once --send \
    --state /var/lib/filtra/dot-alert-state.json
```

Opções: `--once`, `--interval <s>`, `--send`, `--fail-on-alert` (sai com 2 se
houver alerta; útil em teste controlado), `--state <arquivo>`, `--config`,
`--base-url`.

Variáveis (somente nomes; valores nunca são versionados):

| Variável | Uso |
|---|---|
| `DOT_ALERT_BASE_URL` | base da API (padrão `http://127.0.0.1:5000`) |
| `METRICS_TOKEN` / `JOBS_SECRET` | leitura de `/api/metrics` |
| `DOT_ALERT_WEBHOOK_URL` | destino do alerta; só usado com `--send` |

## 4. Canais

| Canal | Alertas | Situação nesta missão |
|---|---|---|
| Render Notifications (e-mail/Slack) | A5, A7, A9 (plataforma) | **não configurado** (sem acesso à conta) |
| UptimeRobot / Better Stack em `/api/live` e `/api/ready` | A7 | **não configurado** (sem credenciais) |
| Executor acima + webhook (Slack/Discord/Teams/e-mail) | A1–A4, A6, A8, A10–A12 | **não configurado** (sem webhook autorizado) |
| Busca em logs por `request_id` | investigação | disponível via Render Dashboard quando houver acesso |

Passos de ativação (quando houver autorização):

1. cadastrar o webhook no destino e guardar a URL em segredo do ambiente;
2. definir `METRICS_TOKEN` no serviço da API e o mesmo valor no executor;
3. rodar `--once` em dry-run e revisar o primeiro snapshot;
4. rodar com `--send` em um alerta induzido em staging (ver §6);
5. manter o executor em daemon e confirmar o recebimento no canal;
6. registrar data/operador da ativação (hoje: **não ativado**).

## 5. Regras

| # | Alerta | Fonte na API | Dispara quando |
|---|---|---|---|
| A1 | Erros HTTP | `http_5xx_total`, `http.routes[*].errors` | 5xx/requisições > 5% (mín. 50 req.) ou erros de uma rota > 10 |
| A2 | Estados ambíguos | `dot_chat_ambiguous`, `dot_http_idempotency_ambiguous`, `dot_ledger_sweep_ambiguous` | qualquer incremento na janela |
| A3 | Reserva × consumo | `dot_ledger_finalize_error`, `dot.pending_sent_over_grace` (opcional) | erro de liquidação ou reserva enviada além da carência |
| A4 | Orçamento | `dot_budget_exceeded`, `dot_budget_alert_critical` | > 10 excedidos/h ou alerta crítico |
| A5 | Scheduler | `dot.scheduler` | `last_error`, timer inativo ou rodada atrasada (2× tick) |
| A6 | Worker | `dot.agent_worker` | `stopped` ou tick em execução > 30 min |
| A7 | Health | `/api/health` | 3 verificações consecutivas com falha |
| A8 | Provedor de IA | `ai_provider_call_failed/_completed`, `ai_not_configured` | ≥ 3 falhas sem sucesso na janela ou IA não configurada |
| A9 | Banco | `/api/health` `db_ok`, `dot_ledger_reserve_error`, `_sweep_error` | banco fora ou erro de infraestrutura do ledger |
| A10 | Idempotência | `dot_http_idempotency_complete_lost`, `dot_idempotency_unavailable` | qualquer incremento |
| A11 | Chave reutilizada | `dot_idempotency_key_reused` | qualquer incremento (sinal de cliente/bug) |
| A12 | Latência | `http.routes["POST /api/dot/chat"].p95_ms` | p95 > 20 s com ≥ 20 amostras |

O campo opcional `dot.pending_sent_over_grace` não é exposto hoje por
`/api/metrics`; para cobrir A3 integralmente é preciso acrescentar essa gauge
(consulta em `docs/SUPABASE_READONLY_ACCESS.md`) ou aceitar A3 apenas pelo
contador de falha de liquidação.

## 6. Validação controlada (executada)

- `tests/dotAlertRules.test.ts`: 27/27 — cada regra dispara no cenário
  correspondente, não dispara em snapshot saudável, ignorando aquecimento e
  reinício de contadores, com token exigido e payload de webhook sem segredo.
- Execução do CLI contra um servidor local de fixture (`staging/`):
  A9 disparou por `db_ok=false`; A7 disparou no terceiro ciclo com estado
  persistido (`healthFailures=3`); `--fail-on-alert` retornou **2**; o token não
  apareceu na saída.
- Envio ao webhook local: HTTP **204**, payload com `source=filtra-dot-alerts`
  e alertas `A7,A9`, sem o token (`token_vazou=false`).

Isso valida **regra e encanamento**, não a configuração em um canal real: não
houve envio para Slack/e-mail/PagerDuty porque não havia webhook autorizado.

## 7. Limitações conhecidas

- Contadores e estado do scheduler/worker são **por processo**; com mais de uma
  instância o executor deve consultar cada instância ou agregar externamente.
- Após deploy/reinício os contadores zeram; as regras de delta ficam em
  aquecimento até a janela completar (sem falso positivo).
- A janela máxima é 1 h: o daemon (ou o estado em arquivo) precisa viver/coletar
  por ao menos esse período.
- A7 depende de estado entre execuções; sem `--state` e sem daemon, use um
  monitor externo de health.
- A5/A6 refletem apenas a instância consultada; locks duráveis são verificados
  separadamente na investigação.
- Nada aqui substitui o runbook de reconciliação manual para reservas ambíguas.
