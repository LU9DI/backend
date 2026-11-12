# Filtra Dot — revisão dos controles financeiros (PR #144)

> Revisão da DSV4 Missão 5 sobre o branch do PR #144 (`8ae072f` + este
> commit). O objetivo é confirmar que **nenhuma chamada a provedor ocorre sem
> reserva durável** e mapear o que ainda falta antes de liberar o recurso.
> Nada foi implantado nem executado em produção.

## 1. Endpoints que consomem tokens

| Endpoint | Chama provedor? | Idempotência HTTP | Ledger durável | Situação |
|---|---|---|---|---|
| `POST /api/dot/chat` | sim | **sim** (`dot_http_idempotency`) | **sim** | pronto para revisão |
| `POST /api/dot/explain` | sim | **não** | **sim** (reserva 260 tokens) | risco residual R3 |
| `/api/dot/monitor/run` | não (determinístico) | n/a | n/a | sem consumo |
| `/api/dot/agent/*` | não (missões determinísticas) | n/a | n/a | sem consumo; ações externas exigem aprovação e executor homologado |
| Scheduler / worker / follow-ups | **não** | n/a | n/a | sem consumo |

## 2. Ordem do fluxo de consumo no chat (código)

1. `claimDotHttpRequest` — registro durável `processing`/`completed`/
   `ambiguous`/`failed_safe`, índice único `(empresa_id, idempotency_key)`;
   replay devolve o corpo original; lease vencido vira ambíguo e **não** é
   retomado; `failed_safe` só reprocessa com prova registrada.
2. `reserveDotExecution` — reserva no ledger com lock transacional por empresa;
   saldo insuficiente ⇒ **429 sem provedor**; falha de leitura ⇒ **503
   fail-closed**; reserva ambígua nunca é liberada pelo relógio.
3. `markDotReservationSent` — se falhar, a chamada **não acontece**.
4. `callAI(..., skipUsageRecord: true)` — provedor é chamado uma vez.
5. `finalizeDotReservation` — insere `ai_usage` **na mesma transação** e marca
   `settled`; retry devolve `duplicate` sem novo consumo.
6. Falha após o envio: `settleDotCallFailure` libera **somente** com prova de
   não envio; caso contrário marca **ambíguo** (mantém reserva) e exige
   reconciliação manual.

Evidências: `routes/dotRoutes.ts` (chat ~L842 claim, ~L1000 reserva, ~L1048
markSent, ~L1066 callAI, ~L1083 finalize), `services/dotHttpIdempotency.ts`,
`services/dotLedger.ts`; testes `tests/dotChatLedger.http.test.ts`,
`tests/dotHttpIdempotency.http.test.ts`, `tests/dotLedger.pg.test.ts` (6/6) e a
suíte PostgreSQL 41/41 no CI.

## 3. `/api/dot/explain` (avaliação)

- Tem **reserva durável** antes do provedor, `markSent` antes do envio,
  finalização com consumo real e liberação com prova de não envio.
- **Não tem** idempotência HTTP: um retry/duplo clique cria **nova reserva** e
  **nova chamada** ao provedor (cobrança dupla possível). O ledger impede
  consumo duplicado da **mesma** reserva, não de requisições distintas.
- O frontend de conversa **não usa** este endpoint.
- Recomendação antes de expô-lo a clientes com retry: exigir
  `X-Idempotency-Key` (reaproveitando `claimDotHttpRequest`/
  `persistDotHttpResponse`) ou documentar formalmente “não repetir”. Até lá,
  fica como **bloqueio para uso externo**, não para a conversa.

## 4. Concorrência, retries e múltiplas instâncias

- Chat: o vencedor é decidido pelo **índice único** no banco, não por mutex em
  memória; reserva e liquidação usam lock transacional e `FOR UPDATE`;
  `ai_usage` só é inserido uma vez por reserva.
- Explain: concorrência de reservas é serializada pelo lock; **retry não é
  deduplicado** (ver §3).
- Múltiplas instâncias: o estado financeiro é durável no banco; **não** depende
  de contadores do processo.
- Crash entre envio e liquidação: reserva fica `sent_at` preenchido e sem
  `settled`; sweep só expira não ambíguas após carência e nunca libera
  ambíguas; reconciliação é manual.

## 5. Contadores locais

`getCounters()` é usado **apenas** em `/api/metrics` e testes. Nenhum caminho
de decisão financeira lê contadores em memória — a proteção é o ledger no
banco (`dot_budget_reservations`) e o registro de idempotência. Requisito da
missão atendido.

## 6. Riscos financeiros remanescentes

| # | Risco | Severidade | Exposição atual |
|---|---|---|---|
| 1 | `/api/dot/explain` sem idempotência | média (alta se exposto com retry) | frontend não usa |
| 2 | Reservas ambíguas exigem reconciliação manual e alerta ativo | alta (operacional) | alertas A2/A3 preparados, **não ativados** |
| 3 | Ledger/idempotência **não estão no build de produção** (master) | alta | produção com reserva em memória e sem idempotência |
| 4 | Contadores e logs sem canais externos | baixa/média | coleta manual |

## 7. Veredito financeiro do PR #144

- `chat`: **controles completos** (idempotência + ledger + liquidação única).
- `explain`: **ledger sim, idempotência não** — aceitável apenas enquanto não
  houver uso externo com retry.
- background: **sem consumo**.
- Produção atual: **não** possui esses controles (ver
  `DOT_PRODUCTION_TIMER_AUDIT.md`), o que reforça a contenção e o bloqueio de
  liberação plena até o ledger estar implantado.
