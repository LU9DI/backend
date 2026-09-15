# Operação resiliente — Filtra.AI

## 1. Webhooks (idempotência + retry)

**Já no código**
- PayPal: tabela `paypal_webhook_events` + `event_id` único; duplicata → `{ action: "duplicate" }`.
- Fila `retry_queue` com backoff e `dedupe_key` (não reenfileira o mesmo job pendente).
- Tabela genérica `webhook_dedupe` (`lib/webhookIdempotency.ts`) para claim por `(source, event_id)`.
- Em falha no processamento, responde 200 + enfileira retry (PayPal) para o provedor não abandonar o evento sem chance de reprocesso interno.

**Do lado de quem envia (obrigatório configurar)**

| Provedor | Onde | Retry automático |
|----------|------|------------------|
| PayPal | Developer → Webhooks | Sim (reenvia se não 2xx) |
| Mercado Pago | Suas integrações → Webhooks | Sim |
| n8n | Workflow → Error Workflow / Retry | Configure 3–5 retries |

URLs:
- PayPal: `https://api.filtraai.com/api/webhook/paypal`
- MP: `https://api.filtraai.com/api/webhook/mercadopago`

## 2. Monitoramento (UptimeRobot grátis)

1. Conta em https://uptimerobot.com
2. Add Monitor → **HTTP(s)**
3. URL: `https://api.filtraai.com/api/live`
4. Interval: **5 minutes**
5. Alert Contacts: e-mail (e Telegram se quiser)
6. Opcional: segundo monitor em `https://api.filtraai.com/api/ready` (exige DB)

`/api/live` **não** deve ser rate-limited (já isento no middleware).

## 3. Rate limiting

Arquivo: `middleware/rateLimitPublic.ts`

Env opcional no Render:
```
RATE_LIMIT_MAX=180
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_AUTH_MAX=40
RATE_LIMIT_WEBHOOK_MAX=300
```

## 4. Backup Postgres (Render)

1. Dashboard Render → banco **PostgreSQL** ligado à API
2. Aba **Backups** / **Point-in-time recovery** (plano pago) ou export manual
3. No mínimo: **1 backup semanal** exportado (`pg_dump`) para storage externo

Comando local de emergência:
```bash
pg_dump "$DATABASE_URL" -Fc -f filtra-$(date +%Y%m%d).dump
```

## 5. Cold start

Render free dorme. Mitigações:
- UptimeRobot a cada 5 min em `/api/live` (mantém quente em parte)
- Preferir plano pago se SLA de pagamento for crítico
- Webhooks de pagamento: provedores fazem retry — combine com idempotência
