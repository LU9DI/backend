# Deploy — Filtra.AI API

## Arquitetura de produção

- **API:** Render, runtime Node.js.
- **Banco:** Supabase PostgreSQL.
- **Frontend:** Cloudflare Pages.
- **Relatórios:** JSON-first, exibidos no painel e distribuídos pelos canais habilitados.
- **Arquivos de relatório:** não são gerados no servidor.
- **Chromium/Puppeteer:** não fazem parte do runtime.
- **SQLite:** somente desenvolvimento local.

O serviço da API é administrado no Render. O deploy deve ser feito pelo fluxo configurado no serviço Render, após validação de build e testes. Este repositório não contém automação de deploy para provedores externos.

## Variáveis obrigatórias em produção

Configure segredos e variáveis no ambiente do serviço Render, nunca no repositório:

- `NODE_ENV=production`
- `JWT_SECRET` — mínimo de 32 caracteres, aleatório
- `ADMIN_PASSWORD` — senha forte para o primeiro administrador
- `USE_SUPABASE_DB=1`
- `SUPABASE_DB_HOST`
- `SUPABASE_DB_USER`
- `SUPABASE_DB_PASSWORD`
- `SUPABASE_DB_PORT` — normalmente 5432
- `SUPABASE_DB_NAME` — normalmente `postgres`
- `WEBAUTHN_RP_ID`
- `WEBAUTHN_ORIGIN`
- `CORS_ORIGINS` — origem do frontend em produção

As demais integrações são opcionais e ativadas conforme suas respectivas variáveis existam, por exemplo IA, Stripe, Mercado Pago, PayPal, SMTP e n8n.

## Health checks

- `GET /api/live` — liveness; não depende do banco.
- `GET /api/ready` — readiness; verifica conexão PostgreSQL.
- `GET /api/health` — diagnóstico operacional completo.

Para a entrada pública da API, use o domínio configurado para a API e verifique `/api/live`.

## Banco

O banco de produção permanece no Supabase. Para esta arquitetura, configure:

```text
USE_SUPABASE_DB=1
SUPABASE_DB_HOST=...
SUPABASE_DB_PORT=5432
SUPABASE_DB_USER=...
SUPABASE_DB_PASSWORD=...
SUPABASE_DB_NAME=postgres
```

Isso evita introduzir um segundo banco e mantém os dados do produto no Supabase.

## Relatório profissional

Trial e planos Pro+ possuem relatório profissional estruturado. O plano Inicial não inclui relatórios.

O relatório é um objeto JSON versionado e serve como fonte única para painel e distribuição multicanal. Endpoints legados de arquivo retornam 410 Gone.

## Segurança operacional

- Nunca commitar `.env` ou segredos.
- Usar variáveis protegidas do Render.
- Manter `CORS_ORIGINS` restrito ao frontend.
- Manter `METRICS_TOKEN` ou `JOBS_SECRET` configurado se métricas protegidas forem expostas.
- Não habilitar `SQLITE_ALLOW_PROD`.
- Não habilitar migrações automáticas de ambiente de desenvolvimento sem uma execução controlada.

## Validação antes de produção

```bash
npm ci
npm run build
npm test
```

Depois do deploy:

```text
GET https://<api>/api/live
GET https://<api>/api/ready
GET https://<api>/api/health
```

A implantação só deve ser considerada concluída quando `/api/live` responder 200, `/api/ready` responder 200 e o diagnóstico confirmar `db_ok=true`.
