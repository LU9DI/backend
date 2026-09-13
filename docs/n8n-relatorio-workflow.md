# n8n — Workflow do relatório mensal Filtra.IA

## Objetivo

Backend gera **1** relatório determinístico (0 tokens de IA) e envia **1** payload com a lista de destinatários.
O n8n **distribui** (WhatsApp / SMS / WeChat / E-mail). Falha em um destino **não** cancela os outros.

## Webhook de entrada

URL sugerida no Render/n8n:

```text
N8N_WHATSAPP_REPORT_URL=https://SEU-N8N/webhook/filtra-relatorio
N8N_WHATSAPP_REPORT_TOKEN=opcional
JOBS_SECRET=...   # no cron que chama POST /api/jobs/whatsapp-reports
```

## Payload (backend → n8n)

```json
{
  "event": "relatorio.mensal",
  "tipo": "relatorio_reputacao_mensal",
  "idempotency_key": "relatorio:EMPRESA_ID:2026-09-12_2026-10-11",
  "cliente_id": "...",
  "nome_empresa": "...",
  "plano": "pro",
  "destinatarios": [
    { "id": "...", "canal": "whatsapp", "destino": "5511999999999", "nome": null }
  ],
  "periodo": { "inicio": "2026-09-12", "fim": "2026-10-11", "chave": "2026-09-12_2026-10-11" },
  "texto": "📊 *Filtra.IA — ...",
  "cached": false,
  "tokens": 0,
  "modelo": "none",
  "automatico": true
}
```

Header opcional: `Idempotency-Key: relatorio:...`

## Fluxo recomendado no canvas

```text
1. Webhook (POST) — path: filtra-relatorio
2. IF / Code — validar tipo === relatorio_reputacao_mensal e texto não vazio
3. Code ou Data Store — idempotência:
      se idempotency_key já processado → return { skipped: true }
      senão gravar key + timestamp
4. Split Out / Item Lists — item por destinatário (campo destinatarios)
5. Switch (canal):
      whatsapp → nó WhatsApp / Evolution / API
      sms      → provedor SMS
      wechat   → provedor WeChat
      email    → SMTP / Resend
6. Continue On Fail = true em cada ramo de envio
7. (Opcional) agregar resultados e log
```

## Regras que o n8n deve respeitar

1. **Idempotência**: mesma `idempotency_key` → não reenviar mensagem.
2. **1 texto, N envios**: nunca chamar a API Filtra de novo para “gerar” por destinatário.
3. **Erro isolado**: WhatsApp 2 falha → SMS/e-mail continuam.
4. **Não inventar texto**: usar só `texto` do payload.
5. Responder **2xx** ao backend só quando o payload foi **aceito** (não precisa esperar todos os envios se usar fila interna — mas se o backend marcar enviado só com 2xx, prefira aceitar após validação + gravação da key).

## Cron (Render / externo)

```bash
curl -X POST "https://api.filtraai.com/api/jobs/whatsapp-reports" \
  -H "Authorization: Bearer $JOBS_SECRET"
```

Sugestão: 1× por hora.

## Canais

| canal     | destino           |
|-----------|-------------------|
| whatsapp  | E.164 sem +       |
| sms       | E.164             |
| wechat    | openid / id       |
| email     | e-mail válido     |
