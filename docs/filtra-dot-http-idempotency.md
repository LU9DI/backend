# Filtra Dot — HTTP idempotency (implementação)

Este documento registra a implementação. O contrato normativo é
[`docs/DOT_HTTP_IDEMPOTENCY.md`](./DOT_HTTP_IDEMPOTENCY.md); em caso de
divergência, o contrato prevalece.

## Escopo

Protege `POST /api/dot/chat`. A chave de idempotência é independente da
idempotência de reserva/liquidação do ledger de tokens: as duas camadas são
necessárias e não se substituem.

## Implementação

- `services/dotHttpIdempotency.ts` — claim durável, replay, transições
  condicionais e classificação da resposta.
- `lib/migrations.ts` — tabela central `dot_http_idempotency` (SQLite e
  PostgreSQL), índice único `(empresa_id, idempotency_key)`.
- `routes/dotRoutes.ts` — claim antes de contexto, caches, histórico, reserva e
  provedor; rejeição de chave ausente/inválida em produção.

## Máquina de estados

| Estado | Significado | Comportamento em duplicata |
| --- | --- | --- |
| `processing` | claim único em curso | HTTP 409 `DOT_REQUEST_IN_PROGRESS` (+ `Retry-After`) |
| `completed` | status e JSON persistidos antes do envio | replay idêntico do status/JSON (`Idempotency-Replayed: true`) |
| `ambiguous` | o provedor pode ter sido chamado | HTTP 409 `DOT_REQUEST_AMBIGUOUS`; reconciliação manual |
| `failed_safe` | falha comprovada antes do envio | retry permitido por transição condicional e auditável |

- Chave ausente em produção: HTTP 400 `DOT_IDEMPOTENCY_KEY_REQUIRED`.
- Chave malformada: HTTP 400 `DOT_IDEMPOTENCY_KEY_INVALID`.
- Mesma chave com payload diferente: HTTP 409 `DOT_IDEMPOTENCY_KEY_REUSED`.
- `processing` mais antigo que 15 min vira `ambiguous` e nunca é retomado.
- Apenas linhas `completed` expiram (24 h). `processing`, `ambiguous` e
  `failed_safe` são evidência de segurança e não são apagadas automaticamente.
- Se a persistência da resposta falhar, a API responde 503
  `DOT_IDEMPOTENCY_PERSIST_FAILED` e nunca devolve sucesso não reproduzível.
- Demonstração anônima nunca compartilha namespace: não lê nem grava respostas
  de outro visitante (e o modo demo é desabilitado em produção).

## Evidências

- `tests/dotHttpIdempotency.test.ts` — 14 testes de contrato em SQLite.
- `tests/dotHttpIdempotency.http.test.ts` — 8 testes HTTP (replay, corrida,
  conflito, ambíguo, multi-tenant, chave obrigatória).
- `tests/dotHttpIdempotency.pg.test.ts` — concorrência real em PostgreSQL
  (requer `DATABASE_URL` descartável).

## Gate de ativação

Não definir `FILTRA_DOT_ENABLED=1` em produção antes de:

1. o backend (PR #144) e a implementação de idempotência estarem integrados;
2. o frontend `/dot/conversa` estar publicado;
3. CI verde no HEAD final e revisão independente aprovada;
4. migração validada em banco descartável/staging;
5. E2E no Render confirmar duplicata concorrente, timeout/retry, replay,
   conflito de payload e estado ambíguo;
6. o procedimento de reconciliação de linhas ambíguas estar acordado.

Esta implementação não executou migração, deploy nem alteração de configuração
no Render.
