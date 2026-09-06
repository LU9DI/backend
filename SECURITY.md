# Segurança — Filtra.IA

## Secrets

| Secret | Rotação | Notas |
|--------|---------|-------|
| `JWT_SECRET` / `JWT_PREVIOUS_SECRET` | 90 dias | Use rotação com kid; login força novo token |
| `STRIPE_SECRET_KEY` / webhook | se vazou | Revogar no dashboard Stripe |
| `MP_ACCESS_TOKEN` / `MP_WEBHOOK_SECRET` | se vazou | Regenerar no Mercado Pago |
| `PAYPAL_*` | se vazou | Regenerar no PayPal |
| `JOBS_SECRET` | 180 dias | Só jobs internos |
| `N8N_WEBHOOK_SECRET` | 180 dias | Header x-n8n-secret |
| Admin password | após compartilhar | MFA recomendado |

**Nunca** commitar secrets no Git. Só `backend/.env` local (gitignored).

## Headers

API aplica: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS em produção.

## Auth

- JWT com rotação de chave
- MFA opcional no admin
- WebAuthn (digital) opcional
- Rate limit em login, reviews e WhatsApp patch

## Pagamentos

- Webhooks com verificação de assinatura (Stripe / MP / PayPal)
- Ativação de plano só após evento confiável
- Cancelamento self-service não bloqueia imediatamente (fim do período pago)

## Dados

- WhatsApp de cliente anonimizado (LGPD sweep)
- Backup SQLite via `/api/jobs/backup`
- Em escala: migrar para Postgres (ver DEPLOY.md futuro)
