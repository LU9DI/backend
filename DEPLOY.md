# Deploy checklist — Filtra.IA

## 1. Variáveis obrigatórias (produção)

```env
NODE_ENV=production
JWT_SECRET=...          # >= 32 chars aleatórios
APP_URL=https://seudominio.com
FRONTEND_URL=https://seudominio.com
API_PUBLIC_URL=https://api.seudominio.com   # ou mesmo host
CORS_ORIGINS=https://seudominio.com

# Pagamentos (pelo menos um)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
# e/ou
MP_ACCESS_TOKEN=APP_USR-...
MP_WEBHOOK_SECRET=...
MP_NOTIFICATION_URL=https://api.seudominio.com/api/webhook/mercadopago
# e/ou
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_WEBHOOK_ID=...
PAYPAL_MODE=live

# IA — usada pelo restante do SaaS; o relatório WhatsApp não chama IA
GROQ_API_KEY=...
# opcional failover
GEMINI_API_KEY=...

# Jobs (cron)
JOBS_SECRET=...

# Envio automático do relatório via n8n/WhatsApp
N8N_WHATSAPP_REPORT_URL=https://seu-n8n/webhook/relatorio-whatsapp
N8N_WHATSAPP_REPORT_TOKEN=...

# E-mail
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=noreply@seudominio.com
```

## 2. Webhooks públicos (HTTPS)

| Provider | URL |
|---|---|
| Stripe | `POST /api/webhook/stripe` |
| Mercado Pago | `POST /api/webhook/mercadopago` |
| PayPal | `POST /api/webhook/paypal` |
| n8n | `POST /api/webhook/n8n` |

## 3. Cron sugerido

```bash
# Trial 1–2 dias + expirações + retries
0 9 * * * curl -X POST -H "Authorization: Bearer $JOBS_SECRET" https://api.../api/jobs/expirations

# Trial meio do período (~dia 5)
0 10 * * * curl -X POST -H "Authorization: Bearer $JOBS_SECRET" https://api.../api/jobs/trial-mid

# Relatórios mensais via WhatsApp — executar diariamente.
# O backend decide quais clientes estão no dia de aniversário da assinatura.
20 9 * * * curl -X POST -H "Authorization: Bearer $JOBS_SECRET" https://api.../api/jobs/whatsapp-reports

# Backup SQLite diário
30 3 * * * curl -X POST -H "Authorization: Bearer $JOBS_SECRET" https://api.../api/jobs/backup

# Fila de retry a cada hora
15 * * * * curl -X POST -H "Authorization: Bearer $JOBS_SECRET" https://api.../api/jobs/retry-failures
```

O relatório não é disparado no primeiro dia do mês. Para novas assinaturas, `report_next_due_at` é criado na ativação como **um mês após a data de ativação**, preservando o dia da assinatura quando possível. Ex.: assinatura em 12/09 → relatório em 12/10; assinatura em 27/09 → 27/10. Para meses sem esse dia, usa-se o último dia disponível.

O job é diário de propósito: se o Render/cron atrasar algumas horas ou um cliente estiver no limite do mês, o relatório continua sendo enviado sem depender de um único horário fixo. O envio só é marcado como concluído depois que o webhook n8n responder com sucesso.

## 4. Health

`GET /api/health` deve retornar `ok: true` e flags `stripe` / `paypal` / `pix` / `ai`.

## 5. Cookies / CORS

- Produção: cookies com `Secure; SameSite=None` se front e API em domínios diferentes.
- Preferir mesmo domínio (proxy reverso) com `SameSite=Lax`.

## 6. Pós-deploy

1. Login admin
2. Comprar plano teste (Stripe test / MP sandbox)
3. Confirmar webhook no admin técnico
