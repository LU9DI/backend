# Filtra.AI — checklist de deploy (Render + Vercel)

## 1. GitHub
- Branch de produção: **main**
- Último push deve incluir: trial estável, n8n, quotas 100/300

## 2. Render (API)
- Root Directory: `backend`
- Branch: `main`
- Build: `npm install && npm run build`
- Start: `npm start`
- Health: `/api/health`

### Env obrigatórias
```
NODE_ENV=production
JWT_SECRET=... (≥32 chars)
DATABASE_URL=... (Postgres do Render)
APP_URL=https://filtraai.com
FRONTEND_URL=https://filtraai.com
CORS_ORIGINS=https://filtraai.com
WEBAUTHN_RP_ID=filtraai.com
WEBAUTHN_ORIGIN=https://filtraai.com
```

### Env recomendadas
```
GROQ_API_KEY=
GEMINI_API_KEY=
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
MP_ACCESS_TOKEN=
MP_WEBHOOK_SECRET=
MP_PUBLIC_KEY=
SMTP_HOST= SMTP_USER= SMTP_PASS=
N8N_WEBHOOK_URL=
N8N_WEBHOOK_SECRET=
VAPID_PUBLIC_KEY= VAPID_PRIVATE_KEY=
```

## 3. Após deploy — testes
```bash
curl https://SEU-API.onrender.com/api/health
curl https://SEU-API.onrender.com/api/planos
curl https://SEU-API.onrender.com/api/n8n/status
```

Esperado:
- `ok: true`, `db: postgres`
- planos inicial=100, pro=300
- n8n status 200 (mesmo se `configured: false`)

Trial (senha mín. 8 + maiúscula + número + especial):
```bash
curl -X POST .../api/trial/ativar -H 'Content-Type: application/json' \
  -d '{"cnpj":"11222333000181","nome_empresa":"Teste","email":"t@x.com","senha":"Teste@12"}'
```

## 4. Vercel (front)
- `NEXT_PUBLIC_API_URL=https://SEU-API.onrender.com`
- Domínio: filtraai.com
