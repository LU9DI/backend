# Supabase (Postgres principal) + Render (API reserva)

O Render free **dorme** e cai com frequência. Arquitetura recomendada:

```
Frontend (Vercel)
   ├─ API principal  →  Railway / Fly / Oracle / outro (sempre que possível)
   └─ API reserva    →  Render (failover automático)
         │
         └─ ambos usam o MESMO Postgres: Supabase
```

## 1. Criar projeto no Supabase

1. https://supabase.com → New project  
2. Region próxima (ex.: South America se disponível, senão US East)  
3. Anote a senha do banco

## 2. Connection string

**Settings → Database → Connection string**

Preferência no free tier:

- **Mode: Transaction** (pooler)  
- Host tipo: `aws-0-....pooler.supabase.com`  
- Porta **6543**

Formato:
```text
postgresql://postgres.[PROJECT-REF]:[SENHA]@aws-0-XX.pooler.supabase.com:6543/postgres
```

URI “Session” / porta 5432 também funciona, mas esgota conexões mais rápido.

## 3. No Render (e em qualquer API clone)

Environment:
```text
DATABASE_URL=postgresql://postgres.xxx:SENHA@....pooler.supabase.com:6543/postgres
# opcional alias:
# SUPABASE_DB_URL= (mesma URL)

PG_POOL_MAX=4
NODE_ENV=production
JWT_SECRET=...
APP_URL=https://filtraai.com
FRONTEND_URL=https://filtraai.com
CORS_ORIGINS=https://filtraai.com
```

**Importante:** apague ou deixe de usar o Postgres do Render. Um único banco (Supabase) para todos os hosts de API.

## 4. Frontend (Vercel) — failover

```text
NEXT_PUBLIC_API_URL=https://SUA-API-PRINCIPAL.onrender.com
NEXT_PUBLIC_API_URL_BACKUP=https://filtra-ia-api.onrender.com
```

- Principal = a que você considerar mais estável (pode ser outro serviço Render, Railway, etc.)  
- Backup = Render reserva  
- Se a principal der timeout/502/503, o front troca sozinho para o backup

## 5. Por que não “só Supabase” para a API?

Supabase hospeda **Postgres** (e Edge Functions Deno). Sua API é **Node/Express** — continua em Render/Railway/Fly. O ganho grande é o **banco não sumir** e **várias APIs** lerem o mesmo dado.

## 6. Checklist

- [ ] Supabase projeto criado  
- [ ] `DATABASE_URL` pooler em todas as instâncias da API  
- [ ] Render redeploy  
- [ ] Vercel com primary + backup  
- [ ] `curl /api/health` mostra `db: postgres` e sobe estável  
- [ ] Trial funciona  
