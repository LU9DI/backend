# Pix (Mercado Pago) — Filtra.IA

## Modos

| Modo | Endpoint | UX |
|------|----------|----|
| **Avulso** | `POST /api/pix/avulso` | QR Code + Copia e Cola |
| **Agendado** | `POST /api/pix/agendado` | QR com `vence_em` (até 29 dias) |
| **Recorrente** | `POST /api/pix/recorrente` | Link de assinatura MP (`init_point`) |

Webhook: `POST /api/webhook/mercadopago`  
Status: `GET /api/pix/status` · `GET /api/pix/payment/:id`

## Env (`backend/.env`)

```env
MP_ACCESS_TOKEN=APP_USR-...          # ou TEST-... (sandbox)
MP_WEBHOOK_SECRET=                   # opcional em dev; recomendado em prod
MP_NOTIFICATION_URL=https://SUA_API/api/webhook/mercadopago
API_PUBLIC_URL=https://SUA_API       # alternativa se não usar MP_NOTIFICATION_URL
```

1. Crie app em https://www.mercadopago.com.br/developers  
2. Copie o **Access Token** (teste ou produção)  
3. Webhooks → URL da API `/api/webhook/mercadopago`  
4. Eventos: `payment`, `merchant_order`, `subscription_preapproval`

## Exemplos

### Avulso
```bash
curl -X POST http://localhost:5000/api/pix/avulso \
  -H 'Content-Type: application/json' \
  -d '{"plano":"pro","empresa_id":"UUID","email":"cliente@email.com"}'
```
Resposta: `qr_code` (copia-e-cola), `qr_code_base64` (imagem), `payment_id`.

### Agendado
```bash
curl -X POST http://localhost:5000/api/pix/agendado \
  -H 'Content-Type: application/json' \
  -d '{"plano":"ultra","empresa_id":"UUID","vence_em":"2026-09-20T23:59:00.000-03:00"}'
```

### Recorrente
```bash
curl -X POST http://localhost:5000/api/pix/recorrente \
  -H 'Content-Type: application/json' \
  -d '{"plano":"pro","empresa_id":"UUID","email":"cliente@email.com"}'
```
Abra `init_point` / `authorize_url` no browser.

## Notas

- **Pix Automático (BACEN)** puro exige homologação bancária; aqui o recorrente usa **assinatura Mercado Pago** (cobrança automática no ciclo mensal/anual do plano).
- Ativação do plano: webhook `payment` approved ou consulta `GET /api/pix/payment/:id`.
- Health: `GET /api/health` → campo `pix`.
