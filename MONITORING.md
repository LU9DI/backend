# Monitoramento de saúde — Filtra.AI

## Endpoints

| URL | Uso |
|-----|-----|
| `GET /api/live` | Processo vivo (sempre 200 se o Node subiu) |
| `GET /api/ready` | Pronto para tráfego (Postgres OK) → 200/503 |
| `GET /api/health` | Detalhado (DB, memória, pagamentos, IA, n8n, build) |

### Deploy válido
No health deve aparecer:
```json
"build": { "version": "1.0.3", "marker": "health-monitor+n8n+quota100+pwd8" }
```
Se **não** aparecer, o Render ainda está em código antigo.

## Render

Em **Settings → Health Check Path**:
```
/api/ready
```
(ou `/api/health` se preferir o check completo)

O Render reinicia a instância se o path retornar ≠ 2xx por tempo demais.

## Monitoramento externo (grátis)

### UptimeRobot (recomendado)
1. Crie conta em https://uptimerobot.com
2. Add New Monitor → **HTTP(s)**
3. URL: `https://filtra-ia-api.onrender.com/api/ready`
4. Interval: 5 minutos
5. Alert Contacts: seu e-mail / Telegram

Opcional: segundo monitor em `/api/health` (Keyword: `"status":"healthy"`).

### Better Stack / Cronitor / Pingdom
Mesma URL `/api/ready`. Alertas por e-mail, Slack ou Discord.

## Alerta via webhook (opcional)

No Render, env:
```
HEALTH_ALERT_WEBHOOK_URL=https://seu-n8n-ou-discord-webhook
HEALTH_HEAP_WARN_MB=450
```

Quando DB ou memória falham, a API posta um JSON (cooldown 15 min).

## Checklist rápido
```bash
curl -s https://filtra-ia-api.onrender.com/api/live
curl -s https://filtra-ia-api.onrender.com/api/ready
curl -s https://filtra-ia-api.onrender.com/api/health | head -c 800
```
