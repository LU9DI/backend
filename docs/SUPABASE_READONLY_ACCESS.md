# Supabase — verificação somente leitura (schema, migrations, backup/PITR)

> **Nenhum SQL de alteração foi executado.** Não havia credenciais, CLI ou
> sessão do Supabase neste ambiente; a inspeção do projeto de produção continua
> **pendente de acesso**. O que segue é evidência indireta + o roteiro exato de
> leitura para executar quando houver autorização.

## 1. Identificação do projeto

- O repositório **não** contém project ref real nem `.env` versionado:
  `.env.example` traz apenas o placeholder `SUPABASE_DB_HOST=db.seu-projeto.supabase.co`.
- O código aceita duas formas de conexão (`lib/db.ts`): `DATABASE_URL` ou o
  conjunto `SUPABASE_DB_HOST`/`_PORT`/`_USER`/`_PASSWORD`/`_NAME`. O script
  `scripts/migrate-render-to-supabase.ts` usa como padrão o pooler
  `aws-0-us-west-2.pooler.supabase.com` (região sugerida: us-west-2), mas esse
  host é compartilhado e **não identifica o projeto**.
- Evidência pública de que o runtime usa Postgres gerenciado:
  `GET /api/health` de produção → `{db:"postgres", db_ok:true}`;
  `GET /api/ready` → `{ready:true, db:{ok:true, engine:"postgres"}}`.
- O projeto correto **precisa ser confirmado** no painel (Database → Settings →
  General → Reference) e confrontado com os **nomes** das variáveis do serviço
  `filtra-ia-api` no Render (host, porta `5432`/pooler, banco).

## 2. O que o boot espera do schema

`runCentralMigrations` (`lib/migrations.ts`) aplica, sob advisory lock:

1. tabelas centrais (empresas, reviews, auth);
2. colunas de reviews;
3. schema de auth e MFA;
4. schema de ações do Dot;
5. **ledger** `dot_budget_reservations` + índices + colunas em `ai_usage`;
6. **idempotência HTTP** `dot_http_idempotency` + índice único
   `ux_dot_http_idempotency_empresa_key (empresa_id, idempotency_key)`.

O boot **falha fechado** se o schema existente for incompatível (por exemplo,
coluna legada `tenant_id` em `dot_http_idempotency` ou índice único ausente).

Estruturas esperadas (para conferência):

- `dot_budget_reservations`: `id, empresa_id, feature, plan, status,
  tokens_reserved, tokens_real, tokens_estimated, provider, ambiguous,
  ambiguous_reason, ai_usage_id, execution_ref, sent_at, created_at,
  updated_at, expires_at, settled_at`;
  índices `idx_dot_budget_reservations_empresa (empresa_id,status,created_at)`,
  `idx_dot_budget_reservations_exec (empresa_id,execution_ref)`,
  `ux_dot_budget_reservations_ai_usage (ai_usage_id) WHERE ai_usage_id IS NOT NULL`.
- `dot_http_idempotency`: `id, empresa_id, endpoint, idempotency_key,
  request_hash, status, response_status, response_json, created_at,
  updated_at, completed_at, expires_at`; único `(empresa_id, idempotency_key)`.
  A presença da coluna legada `tenant_id` ou a falta de qualquer coluna acima
  faz o boot falhar (fail-closed).
- `ai_usage`: colunas `provider`, `feature`, `tokens_input`, `tokens_output`
  (além das originais) e índice `idx_ai_usage_feature (empresa_id, feature,
  criado_em)`.

## 3. Consultas somente leitura (executar só quando autorizado)

```sql
-- versão e extensões
select version();
select extname from pg_extension order by 1;

-- tabelas e colunas do Dot
select table_name, column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name like 'dot_%'
 order by table_name, ordinal_position;

-- índices (inclui o único de idempotência)
select tablename, indexname, indexdef
  from pg_indexes
 where schemaname = 'public' and (tablename like 'dot_%' or tablename = 'ai_usage')
 order by tablename, indexname;

-- constraints
select conrelid::regclass::text as table_name, conname, contype,
       pg_get_constraintdef(oid) as definition
  from pg_constraint
 where connamespace = 'public'::regnamespace
   and conrelid::regclass::text like 'dot_%'
 order by 1, 2;

-- estado operacional do ledger (somente contagens, sem conteúdo)
select status, ambiguous, count(*) from dot_budget_reservations group by 1,2;
select status, count(*) from dot_http_idempotency group by 1;

-- volume de consumo do Dot no mês corrente
select count(*), coalesce(sum(tokens),0) from ai_usage
 where feature = 'dot' and criado_em >= date_trunc('month', now());
```

Comparação: o schema criado do zero em staging (PostgreSQL 17.11) tem digest
`01744af975c03a5b8ee75b876596e2a295cafa5a033e78410a4dc48d1b1adf0d`; o digest de
constraints é `cf76261080c3bf98d50356e21bd7c2e9672e7b91831352427c3e597fecdd22da`
(ver `staging/logs/migration-check.log`). Como produção tem dados e tabelas
adicionais, a comparação deve ser **por tabela**, usando as consultas acima —
não pelo digest global.

## 4. Backup e PITR (somente leitura no painel)

- Supabase → **Database → Backups**: plano, retenção, último backup físico e
  horário; verificar se há backup diário e por quanto tempo é retido.
- **PITR** (quando contratado): janela disponível em `Database → Backups →
  Point in Time`; registrar a janela e o último restore testado.
- **Connection pooling**: confirmar pooler/porta usada pelo Render e limites de
  conexão (`Database → Connection pooling`).
- Registrar também: região do projeto, versão do Postgres e tamanho atual.

Não foi possível confirmar nenhum desses itens sem acesso.

## 5. Compatibilidade migrations × schema atual

- Evidência disponível: aplicação dupla idempotente e backup/restore em banco
  descartável PostgreSQL 17.11 (Missão 2), com falha injetada e recuperação.
- Compatibilidade com o schema **real de produção** depende das consultas da
  seção 3; até lá o veredito é **não verificado**.

## 6. Acessos necessários

1. leitura no painel do projeto Supabase de produção (schema, backups, PITR,
   pooling), ou role Postgres **read-only** com `CONNECT` e `USAGE` no schema
   `public` para executar apenas os `SELECT` acima;
2. confirmação do project ref e do host/porta usados no `DATABASE_URL` do
   Render;
3. janela aprovada antes de qualquer alteração (migração de produção está
   proibida nesta missão).
