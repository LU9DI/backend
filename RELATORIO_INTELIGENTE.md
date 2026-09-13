# Relatório inteligente (multicanal)

Não usa PDF nem tokens de IA.

## Fluxo

1. Cliente escolhe canais no painel (WhatsApp, SMS, e-mail, WeChat)
2. `POST /api/empresa/:ref/relatorio/enviar` monta texto só com dados do painel
3. Evento n8n `report.mensal` com `{ texto, destinatarios, metricas }`
4. n8n distribui pelos canais

## Rotas

| Método | Path | Descrição |
|--------|------|-----------|
| GET | `/api/empresa/:ref/relatorio/destinatarios` | Lista destinos |
| PUT | `/api/empresa/:ref/relatorio/destinatarios` | Salva destinos |
| POST | `/api/empresa/:ref/relatorio/enviar` | Gera + envia via n8n |

## Planos

- **Com relatório:** trial, pro, ultra, corporativo, rei
- **Sem:** inicial (pago)

## Legado PDF

Rota `/api/empresa/:ref/relatorio.pdf` só sobe se `ENABLE_LEGACY_PDF=1`.
