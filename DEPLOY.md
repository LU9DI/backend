# Deploy — Filtra.AI

A API de produção usa runtime Node.js e o relatório profissional estruturado como formato canônico.

## Arquitetura de produção

- **API:** Jataí Cloud, São Paulo.
- **Banco:** Supabase PostgreSQL — o Jataí hospeda somente a API.
- **Frontend:** Cloudflare Pages.
- **Relatórios:** JSON-first, exibidos no painel e distribuídos por e-mail, WhatsApp, SMS e WeChat.
- **Runtime:** Node.js 20 em Docker.
- **Arquivos de relatório:** não são gerados no servidor.
- **Chromium/Puppeteer:** não fazem parte do runtime.
- **SQLite:** somente desenvolvimento local.

O Jataí detecta o `Dockerfile` na raiz e usa a imagem customizada. O container deve escutar em `process.env.PORT`; o `Dockerfile` atual usa `3000` como fallback local e o Jataí injeta a porta configurada no app.

## Variáveis obrigatórias em produção

A API deve receber pelo ambiente do Jataí, sem gravar segredos no repositório:

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

As demais integrações são opcionais e são ativadas conforme suas respectivas variáveis existam, por exemplo IA, Stripe, Mercado Pago, PayPal, SMTP, n8n e WeChat.

## Health checks

- `GET /api/live` — liveness; não depende do banco.
- `GET /api/ready` — readiness; verifica conexão PostgreSQL.
- `GET /api/health` — diagnóstico operacional completo.

Para a entrada pública da API, prefira o domínio da API atrás do Cloudflare e use `/api/live` para verificar se o processo está respondendo.

## Deploy no Jataí

O projeto já possui um Dockerfile compatível com o runtime:

1. Jataí detecta o Dockerfile.
2. O Docker instala as dependências declaradas no `package.json`; `tsx` está em `dependencies` porque é necessário ao `npm start` do runtime.
3. `npm start` executa `tsx node-entrypoint.ts`.
4. A aplicação escuta em `0.0.0.0:${PORT}` (porta 3000 no fallback local).
5. O Jataí publica HTTPS automaticamente.

O primeiro app Base do time é gratuito conforme o plano atual do Jataí. Não devemos criar worker separado nesta etapa: os processos adicionais são cobrados como Hex independentes.

## Banco

O banco de produção permanece no Supabase.

A API aceita duas formas de conexão PostgreSQL, mas para esta implantação usamos explicitamente:

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
- Usar secrets/variáveis cifradas do Jataí.
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
