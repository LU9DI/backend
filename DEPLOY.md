# Deploy Filtra.IA API (Render)

## Branch correta

O serviço no Render deve apontar para **uma** destas branches e fazer deploy do commit mais recente:

- `main` — build esperado: `1.1.4+` / marker com `pdf-postgres`
- `fix/render-production-start` — build esperado: `1.1.5` / `pdf-postgres-trial-fix`

## Como confirmar

```bash
curl -sS https://api.filtraai.com/api/live
```

Se ainda aparecer `1.1.3` ou `codex-hardening-n8n-pg-metrics-intact`, o Render **não** está no commit novo.

## Passos no Render

1. Dashboard → serviço da API
2. Settings → Branch = `main` **ou** `fix/render-production-start` (a que você usa)
3. Manual Deploy → Deploy latest commit
4. Aguarde Live
5. Confira `/api/live` de novo

## PDF

Trial e planos Pro+ geram PDF. Plano `inicial` não.

## Segurança

Em produção, defina `ALLOW_PLAN_SWITCH=0` (ou remova a variável) para não permitir troca de plano sem pagamento.
