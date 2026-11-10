# Filtra Dot — HTTP idempotency contract

## Scope

The contract currently protects `POST /api/dot/chat`. It is intentionally
scoped by authenticated tenant, endpoint, and client-generated key. It is not
a replacement for the token ledger's reservation idempotency.

## Client requirements

- Generate one unpredictable key for each intentional message (UUID is
  sufficient).
- Persist the key together with the exact message and session payload before
  sending.
- Reuse the same key and payload after timeout, connection loss, HTTP 5xx, or
  `DOT_IDEMPOTENCY_IN_PROGRESS`.
- Do not generate a new key while the prior result is pending or ambiguous.
- A new key is permitted only for a new intentional message, or after a
  definitive `DOT_TOKEN_LIMIT` rejection (the provider was not called).
- Send `Idempotency-Key` (the API also accepts `X-Idempotency-Key`).

## Server state machine

| State | Meaning | Duplicate behavior |
| --- | --- | --- |
| `pending` | The unique request claim is held; processing may be running | HTTP 409 `DOT_IDEMPOTENCY_IN_PROGRESS` |
| `completed` | HTTP status and JSON response were durably stored before send | Replay the stored status and JSON |
| `ambiguous` | The outcome cannot be proven safe to execute again | HTTP 409 `DOT_IDEMPOTENCY_AMBIGUOUS`; operator reconciliation required |

A reused key with a different payload hash returns HTTP 409
`DOT_IDEMPOTENCY_PAYLOAD_MISMATCH`. Production requests without a key return
HTTP 428 `DOT_IDEMPOTENCY_KEY_REQUIRED`.

The claim is acquired before context loading, either response cache, session
history mutation, token reservation, or provider invocation. The unique
constraint and transaction make the claim shared across API processes.

## Crash and retention behavior

- A pending request older than 15 minutes becomes ambiguous, never reclaimable.
- Any 5xx response after a claim is conservatively ambiguous. This includes
  cases where the provider may not have been reached; safety is preferred over
  automatic replay.
- Completed responses are eligible for cleanup after 24 hours.
- Pending and ambiguous rows are never removed by automatic retention cleanup.
- If persisting the final response fails, the API returns
  `DOT_IDEMPOTENCY_PERSIST_FAILED` and does not send the unpersisted success.

## Rollout gate

Do not set `FILTRA_DOT_ENABLED=1` in production until:
1. backend PR #146 is integrated after its base PR #144;
2. frontend PR #203 is integrated;
3. backend unit/integration and PostgreSQL multi-process CI pass;
4. E2E confirms concurrent duplicate, timeout/retry, completed replay, payload
   mismatch, and ambiguous outcome behavior against the Render API;
5. the operational reconciliation procedure for ambiguous rows is agreed.

The schema migration is part of central startup migrations. It has not been
run against production by this work. No Render configuration or deployment
was changed.
