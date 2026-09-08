# UptimeRobot — manter o Render acordado + alertas

O plano **free** do Render desliga a API após ~15 min sem tráfego.  
Ping externo a cada **5 minutos** reduz (e na prática costuma evitar) o sleep.

> Não é garantia 100% da política do Render, mas é o método gratuito padrão.

---

## 1. Criar conta

1. Acesse: https://uptimerobot.com  
2. Sign up (e-mail)  
3. Confirme o e-mail

---

## 2. Monitor principal (keep-alive)

**Add New Monitor**

| Campo | Valor |
|--------|--------|
| Monitor Type | **HTTP(s)** |
| Friendly Name | `Filtra.AI API live` |
| URL | `https://filtra-ia-api.onrender.com/api/live` |
| Monitoring Interval | **5 minutes** (grátis) |
| Monitor Timeout | 30 seconds |

- `/api/live` responde rápido e **não depende do banco** — ideal só para “acordar” o serviço.

Salve (**Create Monitor**).

---

## 3. Monitor de saúde real (opcional, recomendado)

Segundo monitor:

| Campo | Valor |
|--------|--------|
| Type | HTTP(s) |
| Name | `Filtra.AI API ready` |
| URL | `https://filtra-ia-api.onrender.com/api/ready` |
| Interval | 5 minutes |

- `/api/ready` = 200 só se o **Postgres** estiver ok (Supabase).  
- Se cair → e-mail de alerta de verdade.

---

## 4. Alertas

**My Settings → Alert Contacts**

- Adicione seu e-mail  
- (Opcional) Telegram / Slack webhook

Em cada monitor, marque o contato para:
- **Down**
- **Up** (recuperou)

---

## 5. Keyword check (opcional)

No monitor `/api/health`:

- Monitor Type: HTTP(s) – Keyword  
- Keyword: `"ok":true`  
- Alert if keyword **not exists**

---

## 6. Vercel / front

Não precisa de UptimeRobot no front (Vercel não dorme como o Render free).

Se tiver **API backup**:

| Name | URL |
|------|-----|
| API primary | `https://API-PRINCIPAL/.../api/live` |
| API Render reserva | `https://filtra-ia-api.onrender.com/api/live` |

---

## 7. Conferir se está funcionando

1. Deixe o monitor rodar 10–15 min  
2. Abra o log do Render — devem aparecer requests de 5 em 5 min do UptimeRobot  
3. Site deve abrir o trial **sem** esperar 30–60s de “cold start” o tempo todo

---

## Resumo rápido

```text
URL keep-alive:  https://filtra-ia-api.onrender.com/api/live
URL saúde DB:    https://filtra-ia-api.onrender.com/api/ready
Intervalo:       5 minutos
```

Depois do deploy com `/api/live` e `/api/ready`, esses monitores passam a funcionar.
