# Testar o Filtra Dot no localhost

O Dot roda no mesmo servidor da API. No modo local ele usa dados **demonstrativos** (Hotel Aurora, plano Rei) e não exige login.

## Passo a passo

1. Instale as dependências com **`npm install`** (não use `npm ci`: o `package-lock.json` pode estar defasado e o `npm ci` falha).
2. Copie `.env.example` para `.env` e defina:
   - `NODE_ENV=development` (fora de `production`, o modo demo em `localhost` é liberado);
   - `JWT_SECRET` com pelo menos 32 caracteres;
   - `GROQ_API_KEY` e/ou `GEMINI_API_KEY` — **sem uma chave de IA, `/api/dot/chat` e `/api/dot/explain` respondem 503** (o resto funciona sem IA).
3. Banco local: o servidor usa SQLite por padrão (pacotes `sqlite`/`sqlite3`, já nos `devDependencies`). Para usar Postgres/Supabase, defina `DATABASE_URL`.
4. Suba o servidor: `npm run dev` (porta `PORT`, padrão 5000).
5. Acesse **por `localhost` ou `127.0.0.1`** (o modo demo só vale para esses hosts; um IP de rede cai no fluxo autenticado e responde 403).

## Verificação rápida

```bash
curl localhost:5000/api/dot/status          # demo:true, plan:rei
curl localhost:5000/api/dot/briefing
curl -X POST localhost:5000/api/dot/monitor/run
curl -X POST localhost:5000/api/dot/chat -H 'content-type: application/json' \
  -d '{"message":"Resuma minha reputação","session_id":"t1"}'   # precisa de chave de IA
```

## Monitor agendado (opcional)

O agendador do Dot fica desligado por padrão. Para ligar localmente: `FILTRA_DOT_ENABLED=1` e `FILTRA_DOT_FORCE_ON=1`.
Em produção, `FILTRA_DOT_ENABLED=1` também é necessário para as rotas de chat/explicação — a configuração completa de produção está em [docs/DOT_PRODUCAO.md](DOT_PRODUCAO.md).
