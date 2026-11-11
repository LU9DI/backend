# Filtra Dot — observabilidade e catálogo de alertas

> Situação: **instrumentação no código concluída; configuração operacional
> pronta e testada localmente; nenhum alerta está ativado em nenhuma
> plataforma.** Os limiares abaixo são recomendações para ativação pelo
> operador. Nenhum canal externo (e-mail, Slack, PagerDuty, Render Notifications
> etc.) foi conectado e nenhum alerta foi declarado ativo.
>
> A configuração executável dos A1–A12 (limiares, coletor, envio a webhook e
> validação com teste controlado) está em `ops/alerts/` — ver
> `ops/alerts/README.md`. O status continua **não ativado** até que exista
> webhook/token autorizados.

## 1. Correlação ponta a ponta

- O middleware `requestIdMiddleware` (`middleware/security.ts`) aceita
  `X-Request-Id` apenas no formato `^[A-Za-z0-9._:-]{1,128}$`; qualquer outro
  valor é substituído por UUID gerado. O ID é devolvido no header
  `X-Request-Id` de toda resposta.
- `server.ts` abre um contexto `AsyncLocalStorage` por requisição
  (`lib/observability.ts`). Serviços assíncronos chamados a partir da rota
  herdam `request_id` automaticamente.
- O tenant (`empresa_id`) é anexado ao contexto pela rota após a autenticação
  (`bindTenant`). O token JWT **nunca** entra no contexto nem nos logs.
- Logs de falha HTTP (`http_request_failed`) reabrem o contexto com o mesmo
  `request_id` da resposta, inclusive no handler de 5xx.

## 2. Formato dos logs

Uma linha JSON por evento em stdout:

```json
{"ts":"2026-11-10T23:00:00.000Z","level":"info","event":"dot_chat_completed",
 "request_id":"...","empresa_id":"...","provider":"groq","model":"...",
 "latency_ms":812,"tokens":642,"attempt":1,"failover":false,"tipo":"filtra_dot_chat"}
```

Campos fixos: `ts`, `level` (`info|warn|error`), `event`, `request_id`,
`empresa_id`. Os demais campos são específicos do evento.

### Redação obrigatória

`lib/observability.ts` aplica duas barreiras antes de serializar:

1. **Chaves sensíveis** viram `[redacted]`: `authorization`, `cookie`,
   `password`/`senha`, `secret`, `api_key`, `access_token`, `refresh_token`,
   `idempotency_key`, `prompt`, `message`, `content`, `payload`, `body`,
   `text`, `email`, `whatsapp`, `telefone`, `cpf`, `cnpj`.
2. **Valores** passam por remoção de `Bearer <token>`, JWT (`eyJ...`) e chaves
   de provedor (`sk_`, `pk_`, `ghp_`, `xox...`), além de caracteres de
   controle; strings são truncadas em 240 caracteres (3 níveis de
   profundidade).

Consequência: conteúdo do cliente, credenciais e chaves de idempotência não
aparecem em log algum. A cobertura é verificada por
`tests/observability.test.ts`.

## 3. Eventos estruturados instrumentados

| Evento | Nível | Origem | Campos relevantes |
|---|---|---|---|
| `http_request_failed` | error | `server.ts` | `method`, `status` |
| `dot_chat_received` (contador) | — | `routes/dotRoutes.ts` | — |
| `dot_chat_denied` | warn | `dotRoutes.ts` | `reason` |
| `dot_idempotency_claimed` (contador) | — | `dotRoutes.ts` | — |
| `dot_idempotency_replay` | info | `dotRoutes.ts` | `status` |
| `dot_idempotency_in_progress` | info | `dotRoutes.ts` | — |
| `dot_idempotency_ambiguous` | warn | `dotRoutes.ts` | — |
| `dot_idempotency_key_reused` | warn | `dotRoutes.ts` | — |
| `dot_idempotency_claim_failed` | error | `dotRoutes.ts` | `detail` |
| `dot_chat_cache_hit` | info | `dotRoutes.ts` | `kind` (`context`/`semantic`) |
| `dot_budget_exceeded` | warn | `dotRoutes.ts` | `used`, `limit` |
| `dot_budget_unavailable` | error | `dotRoutes.ts` | `stage` (`reserve`/`mark_sent`) |
| `dot_chat_completed` | info | `dotRoutes.ts` | `provider`, `model`, `latency_ms`, `tokens`, `context_mode` |
| `dot_chat_failed` | warn/error | `dotRoutes.ts` | `outcome`, `proven_not_sent`, `provider_called` |
| `dot_explain_completed` / `dot_explain_failed` | info/warn | `dotRoutes.ts` | `provider`, `latency_ms`, `tokens`, `outcome` |
| `dot_http_idempotency_completed` | info | `services/dotHttpIdempotency.ts` | `endpoint`, `response_status` |
| `dot_http_idempotency_complete_lost` | warn | idem | `endpoint`, `response_status` |
| `dot_http_idempotency_ambiguous` | warn | idem | `endpoint` |
| `dot_ledger_reserved` (contador) | — | `services/dotLedger.ts` | — |
| `dot_ledger_reserve_error` | error | idem | `feature`, `detail` |
| `dot_ledger_settled` | info | idem | `reservation_id`, `tokens_charged`, `provider`, `tipo` |
| `dot_ledger_ambiguous` | warn | idem | `reservation_id`, `reason` |
| `dot_ledger_released` | info | idem | `reservation_id`, `reason` |
| `dot_ledger_release_refused` | warn | idem | `reservation_id` |
| `dot_ledger_finalize_error` | error | idem | `reservation_id`, `detail` |
| `dot_ledger_sweep` | warn | idem | `expired`, `ambiguous_marked`, `ambiguous_open` |
| `dot_ledger_sweep_error` | error | idem | `detail` |
| `dot_budget_alert` | warn/error | `emitDotBudgetAlert` | `alert_event`, `severity`, `percent`, `used`, `reserved`, `limit` |
| `ai_provider_call_completed` | info | `groqService.ts` | `provider`, `model`, `latency_ms`, `tokens`, `attempt`, `failover`, `tipo` |
| `ai_provider_call_failed` | warn | idem | `provider`, `model`, `latency_ms`, `attempt`, `status`, `code` |
| `ai_not_configured` | error | idem | `tipo` |

Nenhum evento inclui prompt, resposta do modelo ou mensagem do cliente.

## 4. Endpoints de observabilidade

### `GET /api/live` (público)
Liveness sem tocar banco: `{ ok, live, build, time }`.

### `GET /api/health` (público)
Readiness + estado resumido. Campos relevantes para o Dot:

```json
"dot": {
  "enabled": true,
  "ledger_ready": true,
  "scheduler_active": true,
  "agent_worker_active": true
}
```

Somente booleanos: motivos de erro internos não são expostos publicamente.

### `GET /api/metrics` (protegido em produção)
Exige `X-Metrics-Token: $METRICS_TOKEN` (ou `X-Jobs-Secret: $JOBS_SECRET`).
Devolve:

- `http`: latência por rota (count, errors, p50, p95, max, last) — janela
  `METRICS_WINDOW` (padrão 200 amostras);
- `ai`: latência e estado dos provedores (`getAiLoadStats`);
- `counters`: contadores monotônicos do processo (tabela abaixo);
- `dot`: `enabled`, `ledger_ready`, `scheduler` (`timer_active`, `running`,
  `in_flight`, `stopped`, `last_error`), `agent_worker` (`timer_active`,
  `running`, `in_flight`, `stopped`, `disabled`).

Contadores expostos:

| Contador | Significado |
|---|---|
| `http_requests_total` / `http_4xx_total` / `http_5xx_total` | volume e erros HTTP |
| `dot_chat_received` / `dot_chat_denied` | admissão do chat |
| `dot_idempotency_claimed` / `_replay` / `_in_progress` / `_ambiguous` / `_key_reused` / `_unavailable` | desfechos do claim |
| `dot_chat_completed` / `dot_chat_cache_hit` | resposta servida |
| `dot_chat_failed_safe` / `dot_chat_ambiguous` | falha com prova de não envio / incerta |
| `dot_http_idempotency_completed` / `_complete_lost` / `_ambiguous` / `_failed_safe` | transições do registro de idempotência |
| `dot_budget_exceeded` / `dot_budget_unavailable` | orçamento esgotado / indisponível |
| `dot_ledger_reserved` / `_settled` / `_settled_duplicate` / `_ambiguous` / `_released` / `_release_refused` / `_reserve_error` / `_finalize_error` / `_sweep_expired` / `_sweep_ambiguous` / `_sweep_error` | ledger |
| `dot_budget_alert_emitted` / `_warning` / `_critical` | alertas de orçamento emitidos |
| `ai_provider_call_attempt` / `_success` / `_failed` / `ai_provider_failover_success` / `ai_not_configured` | provedor de IA |
| `ai_usage_*` (quando existirem) | — |

> Contadores são em memória e zeram a cada reinício/deploy. Para séries
> históricas é necessário coletar `/api/metrics` periodicamente (scraper) ou
> usar a métrica equivalente da plataforma. **Nenhum scraper está configurado.**

## 5. Catálogo de alertas recomendados

Todos os itens estão **NÃO CONFIGURADOS**. A coluna "Fonte" indica de onde o
dado sai hoje; a coluna "Ação" é o runbook sugerido.

| # | Alerta | Fonte / condição sugerida | Severidade | Ação imediata |
|---|---|---|---|---|
| A1 | Crescimento anormal de erros | `rate(http_5xx_total) > 5%` de `http_requests_total` em 10 min **ou** `errors` por rota > 10 em 5 min | crítico | verificar `http_request_failed` por `request_id`; checar DB e provedor |
| A2 | Estados ambíguos | `dot_chat_ambiguous` ou `dot_http_idempotency_ambiguous` > 0 em 15 min; `dot_ledger_sweep` com `ambiguous_marked > 0` | crítico | reconciliar reservas/registros ambíguos; não reenviar automaticamente |
| A3 | Divergência reserva × consumo | `dot_ledger_finalize_error` > 0 **ou** reservas `pending` com `sent_at` além da carência (`DOT_SENT_GRACE_MS`, padrão 10 min) | crítico | inspecionar `dot_budget_reservations`; executar reconciliação manual |
| A4 | Orçamento excedido | `dot_budget_exceeded` > 10 em 1 h **ou** `dot_budget_alert` com `percent >= 1` | alto | validar plano/limite; comunicar cliente; verificar abuso |
| A5 | Falha do scheduler | `dot.scheduler.last_error != null`, `timer_active=false` em produção **ou** nenhuma rodada em 2× `tick_ms` | alto | reiniciar processo; verificar lock `dot:scheduler` |
| A6 | Falha do worker de agente | `dot.agent_worker.stopped=true`, `in_flight=true` por > 30 min **ou** `disabled=true` inesperado | médio | verificar missões presas em `working`; reiniciar |
| A7 | Falha de health check | `/api/ready` != 200 por 3 verificações consecutivas | crítico | verificar `db_ok`, pool e logs de boot |
| A8 | Provedor de IA indisponível | `ai_provider_call_failed` ≥ 3 tentativas consecutivas sem `ai_provider_call_completed` em 5 min; `ai_not_configured` > 0 | alto | validar chaves/quotas Groq/Gemini; conferir failover |
| A9 | Falha de banco | `/api/health` `db_ok=false`; `dot_ledger_*_error` > 0; `pingDb` com erro de conexão | crítico | verificar Supabase, conexões, disco e locks |
| A10 | Idempotência indisponível | `dot_http_idempotency_complete_lost` > 0 ou `dot_idempotency_claim_failed` > 0 | alto | verificar tabela `dot_http_idempotency`, índices e réplicas |
| A11 | Chave reutilizada | `dot_idempotency_key_reused` > 0 | baixo (sinal de bug de cliente) | investigar cliente/versão; a resposta já é 409 |
| A12 | Latência do chat alta | p95 de `POST /api/dot/chat` > 20 s por 10 min | médio | verificar provedor e timeout de 45 s do cliente |

### Canais recomendados (não conectados)

1. **Render Notifications** (e-mail/Slack) para A5, A7, A9 — recursos de
   plataforma, sem mudança de código.
2. **Monitor HTTP externo** (ex.: UptimeRobot/Better Stack) em `/api/live` e
   `/api/ready` para A7.
3. **Scraper de `/api/metrics`** (job externo a cada 1–5 min) para A1–A4,
   A6, A8, A10–A12.
4. **Consulta de logs** pelos eventos da seção 3 para investigação (Render
   Dashboard → Logs; busca por `request_id`).

Não há integração de alerta ativa no repositório; a ativação é decisão
operacional do responsável pela conta Render/observabilidade. O coletor de
`ops/alerts/` está pronto e validado com fixture local (27 testes + execução do
CLI + webhook local), mas **nenhum canal real** foi conectado. Nenhum alerta
desta seção foi validado contra produção.

## 6. Limitações conhecidas

- Contadores e latências são **por processo**: múltiplas instâncias Render
  exigem agregação externa; após deploy os valores reiniciam.
- `dot.scheduler`/`dot.agent_worker` refletem apenas a instância consultada.
- Logs vão para stdout sem retenção própria: a retenção é a da plataforma.
- `/api/metrics` sem `METRICS_TOKEN`/`JOBS_SECRET` em produção responde 401
  (falha fechada); o scraper precisa do segredo configurado.
