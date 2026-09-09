# Filtra.AI — API

Express + **Postgres** (produção, preferir Supabase) / SQLite (dev).

## Local

```bash
cp .env.example .env
npm install
npm run dev
```

## Produção (Render)

| Variável | Uso |
|----------|-----|
| `JWT_SECRET` | ≥ 32 chars |
| `DATABASE_URL` ou `SUPABASE_DB_URL` | Postgres |
| `ADMIN_EMAIL` + `ADMIN_PASSWORD` | admin (≥ 12) |
| `APP_URL` / `FRONTEND_URL` / `CORS_ORIGINS` | front |

Opcional: `MP_ACCESS_TOKEN`, PayPal, `GROQ_API_KEY` / `GEMINI_API_KEY`, SMTP, n8n, VAPID.

- Root Directory: **`backend`**
- Branch: **`main`**
- Build: `npm install && npm run build`
- Start: `npm start`

## Saúde / keep-alive

| Rota | Uso |
|------|-----|
| `GET /api/live` | UptimeRobot (acordar Render) |
| `GET /api/ready` | DB ok |
| `GET /api/health` | detalhado |

## Docs úteis (só o essencial)

- `.env.example` — variáveis
- `DEPLOY.md` — deploy
- `SUPABASE_SETUP.md` — banco
- `UPTIMEROBOT.md` — não dormir
- `MONITORING.md` — health
- `SECURITY.md` — segurança
- `RESET_ADMIN.md` — reset admin
