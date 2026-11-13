# Filtra Dot — prontidão operacional para ativação

**Status:** documento de preparação. Nenhuma flag foi ativada e nenhum deploy foi executado.
**Última revisão:** 2026-11-13
**PR:** #144 — `reconcile/dot-production-2026-11-06`
**HEAD verificado da branch:** `b7d1f4cf0854a17a9d67abfece8bb714743b148e`
(inclui as correções dos PRs #149 e #150).
**CI do HEAD:** Backend CI run [43424516563](https://github.com/LU9DI/backend/actions/runs/43424516563)
e Dependency audit run [43424516530](https://github.com/LU9DI/backend/actions/runs/43424516530)
concluídos com sucesso. O check externo
`deploy/lu9di/filtra-ai-api-fallback` é legado do Deno Deploy e não representa
o serviço de produção, que roda em **Render**.

Este documento consolida o que precisa estar pronto **antes** de integrar e ativar o
Dot em produção. Ele complementa [`docs/DOT_PRODUCAO.md`](DOT_PRODUCAO.md) e
[`PR139_PRODUCTION_READINESS_REPORT.md`](../PR139_PRODUCTION_READINESS_REPORT.md).

---

## 1. Provisionamento auditado do primeiro owner

A propriedade é a fonte autoritativa para administração e para `owner_override`
na separação de funções. Ela **nunca** é inferida por `role`, e-mail, primeiro
usuário ou qualquer heurística.

Procedimento operacional (já implementado em `routes/adminOwnerRoutes.ts` e
`lib/empresaOwnership.ts`):

1. Autenticar com uma conta **admin da plataforma** (`ADMIN_EMAIL`/`ADMIN_PASSWORD`
   ou token admin válido).
2. Consultar o estado atual:
   ```http
   GET /api/admin/empresas/<id-ou-slug>/owner
   Authorization: Bearer <admin-token>
   ```
3. Provisionar o responsável, que precisa existir e pertencer à empresa:
   ```http
   POST /api/admin/empresas/<id-ou-slug>/owner
   Authorization: Bearer <admin-token>
   Content-Type: application/json

   { "email": "responsavel@empresa.com" }
   ```
   Alternativa: `{ "user_id": "<uuid>" }`.
4. Verificar a resposta `{ ok:true, owner:{ user_id, updated_at } }` e consultar
   novamente o `GET` acima.
5. O responsável acessa `/dot`, define o PIN administrativo (6 dígitos) e
   desbloqueia a sessão. A administração só aparece quando `is_owner=true`.
6. Verificar em `GET /api/dot/admin/state` que `is_owner=true`, o PIN está
   configurado e a sessão está ativa quando esperado.

Garantias:

- o usuário é validado contra `usuarios` e `empresa_id`;
- a operação grava `audit_logs` com ação `empresa.owner_set`, ator, alvo e
  `source: 'admin'`;
- não existe provisionamento automático de owner para empresas legadas;
- empresa sem owner permanece fail-closed para administração/execução;
- correção de owner usa o mesmo endpoint, sobrescreve o vínculo anterior e é
  auditada.

Rollback operacional: reprovisionar o owner anterior pelo mesmo endpoint. Não
apagar `empresa_owners` nem conceder propriedade manualmente no banco.

---

## 2. Flags necessárias para ativar o Dot

Nenhuma flag abaixo está definida no repositório. A ativação é uma decisão
operacional por ambiente.

| Variável | Efeito | Ativação segura |
|---|---|---|
| `FILTRA_DOT_ENABLED=1` | Monta rotas `/api/dot/*`, `/api/dot/agent/*`, `/api/dot/admin/*`, worker do agente e monitor. Sem ela, só existe o tombstone 403. | Obrigatória para ativar o recurso. |
| `FILTRA_DOT_FORCE_ON=1` | Liga o monitor agendado de todas as empresas elegíveis. Exige `FILTRA_DOT_ENABLED=1`. | Manter **desligado** até uma rodada manual do monitor ser validada. |
| `DOT_AGENT_WORKER_ENABLED=0` | Desliga o worker de missões. | Usar `0` durante a janela inicial; ligar depois de validar missões. |
| `DOT_AGENT_WORKER_INTERVAL_MS` | Intervalo do worker (mín. 60 s). | `300000` salvo necessidade operacional. |
| `FILTRA_DOT_MONITOR_TICK_MS` | Intervalo do monitor (mín. 60 s). | `300000` salvo necessidade operacional. |
| `DOT_ADMIN_SESSION_TTL_MINUTES` | TTL da sessão administrativa após PIN. | `30` (5–480). |
| `GROQ_API_KEY` / `GEMINI_API_KEY` | Chat/explicação e etapas generativas. | Sem nenhuma, chat responde 503; o restante funciona. |

Sequência recomendada:

1. `FILTRA_DOT_ENABLED=1`, `FILTRA_DOT_FORCE_ON` **ausente/0**,
   `DOT_AGENT_WORKER_ENABLED=0`.
2. Validar login, `/api/health`, `/api/dot/status`, provisionamento de owner,
   PIN e administração.
3. Rodar uma única vez `POST /api/dot/monitor/run` em horário de baixa e
   conferir decisões/ações/auditoria.
4. Ligar o worker de missões e acompanhar o status.
5. Só então avaliar `FILTRA_DOT_FORCE_ON=1`.

Rollback: remover `FILTRA_DOT_ENABLED` e reiniciar (recolhe rotas); ou remover
`FILTRA_DOT_FORCE_ON` para parar apenas o monitor; ou
`DOT_AGENT_WORKER_ENABLED=0` para parar missões. Dados não são apagados.

### 2.1 CSRF das mutações de empresa

Toda mutação em `/api/dot/*` (exceto `/api/dot/admin/*` e `/api/dot/agent/*`,
que têm gates próprios) exige `X-Dot-Csrf: 1`; `X-Dot-Admin: 1` é aceito como
fallback administrativo. Sem o header, a resposta é `403 DOT_CSRF_REQUIRED`
antes da autenticação. O frontend precisa enviar esse header nas chamadas de
preparar/aprovar/executar/follow-up/eventos/preferências. Detalhes no
[`DOT_ACTIVATION_RUNBOOK.md`](DOT_ACTIVATION_RUNBOOK.md).

### 2.2 Ledger durável do orçamento

O orçamento do Dot é durável em `dot_budget_reservations` (não em memória):

- reserva (`pending`) → marca de envio (`sent_at`, antes da chamada externa) →
  `settled`/`ambiguous`/`released`/`expired`;
- advisory lock por tenant + `SELECT ... FOR UPDATE` serializam
  reserva/finalização; índice único parcial
  `ux_dot_budget_reservations_ai_usage` garante um consumo por reserva;
- `sweep` nunca expira reserva com `sent_at`; falha ambígua mantém a reserva
  comprometendo o orçamento até reconciliação;
- `markDotReservationSent` recusa reserva que não esteja `pending` (nenhuma
  chamada externa sem transição durável);
- reconciliação administrativa exige sessão PIN, motivo (≥10 caracteres) e,
  para liberar, confirmação explícita `confirm_not_sent=true`, com auditoria.

### 2.3 Idempotência HTTP do chat

`POST /api/dot/chat` exige `X-Idempotency-Key` (ou `Idempotency-Key`) em
produção. O claim é durável em `dot_http_idempotency`, com unicidade por
`(empresa_id, idempotency_key)`, e acontece **antes** de contexto, caches,
histórico, reserva e provedor. O contrato completo está em
[`DOT_HTTP_IDEMPOTENCY.md`](DOT_HTTP_IDEMPOTENCY.md) e a implementação em
[`filtra-dot-http-idempotency.md`](filtra-dot-http-idempotency.md).

- `completed` replica status/JSON originais sem nova cobrança;
- `processing` responde 409 `DOT_REQUEST_IN_PROGRESS`;
- `ambiguous` responde 409 `DOT_REQUEST_AMBIGUOUS` e exige reconciliação;
- `failed_safe` é o único estado retomável, por transição condicional;
- demo anônima nunca compartilha namespace entre visitantes.

Riscos residuais aceitos nesta etapa: a fila de retry e o worker de aquisição
param o timer e agora drenam a promise em voo com teto de 5 s; a corrida
`start × drain` permanece documentada no scheduler/worker. O expurgo de linhas
`ambiguous`/`failed_safe` não é automático e exige procedimento operacional.

### 2.4 Failover entre bases da API

O failover do frontend (`apiFetch`) repete o POST do chat em outra base quando
a primeira responde 502/503/504 ou a conexão cai. A repetição é segura **somente
se todas as bases compartilharem o mesmo PostgreSQL** (mesma tabela
`dot_http_idempotency`):

- base compartilhada → a segunda tentativa reencontra a chave e recebe o replay
  ou `DOT_REQUEST_IN_PROGRESS`/`DOT_REQUEST_AMBIGUOUS`;
- bases com bancos distintos → a segunda base não conhece a chave e executa a
  mensagem de novo (cobrança duplicada).

Antes de ativar, confirmar que `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_API_URL_BACKUP`,
`NEXT_PUBLIC_API_URLS` e o Worker do Cloudflare apontam para o mesmo
`DATABASE_URL`. Enquanto isso não for verdade, o chat deve ser enviado sem
failover.

### 2.5 Reconciliação das linhas HTTP ambíguas

Sinais no log do Render (sem conteúdo de mensagem):

```
[dot-idempotency] requisição ambígua (reconciliação necessária): {"empresaId":...}
[dot-idempotency] lease expirado promovido para ambíguo: {"empresaId":...}
```

Consulta de acompanhamento (somente leitura):

```sql
SELECT status, count(*) FROM dot_http_idempotency
 WHERE updated_at > now() - interval '24 hours'
 GROUP BY status ORDER BY status;
```

Procedimento manual, exclusivo de operador da plataforma e nunca automatizado
pelo backend:

1. Consultar `GET /api/admin/dot/http-idempotency`. A rota exige JWT de
   operador da plataforma e retorna metadados mínimos, sem chave completa,
   prompt ou resposta.
2. Para cada registro, verificar a reserva vinculada em
   `dot_budget_reservations` e correlacionar os registros reais de
   `ai_usage` e a evidência do provedor. Não inferir ausência de envio apenas
   por timeout, reinício ou ausência momentânea de uma linha de consumo.
3. Se o consumo/chamada estiver comprovado, chamar
   `POST /api/admin/dot/http-idempotency/reconcile` com
   `idempotency_id`, `decision: "settle"`, tokens reais inteiros maiores
   que zero, provedor e justificativa operacional de pelo menos 10 caracteres.
   A chamada exige `X-Dot-Admin: 1` e grava a auditoria na mesma transação
   da liquidação.
4. Só se houver prova operacional de que a chamada não foi enviada, usar
   `decision: "release"` com `confirm_not_sent: true` e justificativa.
   O ledger ainda verifica `sent_at IS NULL` sob lock transacional.
5. Se não existir reserva vinculada, o endpoint retorna
   `DOT_HTTP_RECONCILE_NO_RESERVATION`; manter a chave bloqueada e investigar
   manualmente.

**Regra crítica:** a reconciliação resolve apenas a contabilidade. A linha HTTP
permanece `ambiguous` permanentemente, mesmo depois de `settle` ou
`release`. Nunca alterá-la para `failed_safe`, apagar a tombstone ou
reutilizar a mesma chave para retry: isso poderia executar e cobrar novamente
uma operação cujo resultado é incerto. Uma nova chave só representa uma nova
intenção do usuário, não um workaround de reconciliação.

---

## 3. Variáveis, migrações e inicialização

- `DATABASE_URL` PostgreSQL (ou SQLite controlado em dev) e `JWT_SECRET` forte
  seguem a política geral da API.
- `initDB()` executa `runCentralMigrations()`; em PostgreSQL a sequência roda
  sob **advisory lock global**, em conexão dedicada, antes de liberar o uso.
- Migrações centrais relevantes para o Dot: `dot_action_queue`,
  `dot_action_audit`, `dot_internal_cases`, `dot_followups`, `dot_events`,
  `empresa_owners`, `dot_budget_reservations`, colunas de `ai_usage`
  (`provider`, `feature`, `tokens_input`, `tokens_output`) e índices
  únicos/parciais.
- Autenticação: consultas usam `LOWER(TRIM(email))` e a migração cria
  `ux_usuarios_email_normalized`. **Antes** do índice há uma guarda de
  duplicados normalizados: se existir colisão, o boot falha com
  `Migração de autenticação bloqueada` e nenhum usuário é alterado.
- Não há migração manual para executar; a aplicação migra no boot. Ainda assim,
  a primeira execução deve ocorrer em staging com backup e janela aprovada.
- `CREATE INDEX` (não `CONCURRENTLY`) no boot: janela curta de lock de escrita
  em tabelas grandes (`usuarios`, `ai_usage`); executar em baixa carga.
- Não executar migração em produção sem backup e sem validar o advisory lock
  (testes `dbInitializationConcurrency.pg.test.ts`, `dbInstances.pg.test.ts`).
- O bootstrap do primeiro owner é via API de plataforma (seção 1), não por
  script SQL.

---

## 4. Política de retenção da auditoria (proposta)

Não existe expurgo automático implementado para `audit_logs`,
`dot_action_audit` ou `dot_access_audit`. Até decisão formal, **não apagar**
auditoria em produção.

Política mínima proposta, sujeita a revisão jurídica/LGPD e aprovação do
responsável de dados:

| Tabela | Conteúdo | Retenção proposta |
|---|---|---|
| `audit_logs` | Ações administrativas, owner, segurança | 365 dias |
| `dot_action_audit` | Preparação/aprovação/execução/falha | 365 dias |
| `dot_access_audit` | Decisões de acesso do Dot | 180 dias |
| `dot_admin_sessions` | Sessões expiradas/revogadas | limpeza após expiração (30 dias) |
| `dot_admin_pin_attempts` | Tentativas de PIN | janela curta operacional |

Regras:

- exportar para armazenamento imutável antes de qualquer expurgo;
- executar expurgo em job aprovado, com trilha própria e backup;
- suspender expurgo durante investigação de incidente ou disputa;
- nunca registrar PIN, token de sessão ou segredo na auditoria;
- a política e a implementação do job ainda são **pendência operacional**; a
  ausência dele não bloqueia a leitura, mas impede declarar retenção "resolvida".

Consultas de acompanhamento (somente leitura):

```sql
SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM dot_action_audit;
SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM dot_access_audit;
SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM audit_logs;
```

### 4.1 Ferramenta manual de retenção (sem agendamento)

Foi adicionada uma CLI **manual**, com dry-run por padrão, que nunca é
agendada pela aplicação:

```bash
# dry-run (não apaga)
npx tsx scripts/dot-audit-retention.ts

# exportar as linhas expiradas (não apaga)
npx tsx scripts/dot-audit-retention.ts --export ./dot-audit-export.json

# expurgo explícito, somente após aprovação/backup
DOT_AUDIT_RETENTION_CONFIRM=1 npx tsx scripts/dot-audit-retention.ts --purge --yes
```

O expurgo exige `--yes` **e** `DOT_AUDIT_RETENTION_CONFIRM=1`, grava um registro
em `audit_logs` (`dot.audit_retention_purge`) e não apaga `audit_logs`. A
execução continua sendo uma decisão operacional/LGPD; não há scheduler.

### 4.2 Ação legada sem preparador

A compatibilidade `no_preparer_recorded` não é inferida: exige uma linha
explícita em `dot_action_legacy_approval_markers` para o par
`(empresa_id, action_id)`. Não há rota pública/CLI para criá-la; é uma operação
excepcional de migração, manual e auditada, que deve ser revisada antes de uso.

---

## 5. Recuperação e observabilidade

- **Correlação e logs estruturados:** `X-Request-Id` saneado, contexto
  `AsyncLocalStorage` por requisição, eventos JSON com `request_id` e
  `empresa_id`, redação de credenciais/conteúdo e contadores em
  `/api/metrics`. Catálogo de alertas (todos **não configurados**) em
  `docs/DOT_OBSERVABILITY_ALERTS.md`.
- **Liveness/health:** `GET /api/health` retorna `ok:true`, engine do banco e
  subsistemas; verificado em smoke local.
- **Status do Dot:** `GET /api/dot/status` mostra scheduler e worker, incluindo
  `timer_active`, erros e última execução, sem segredos.
- **Auditoria de execução:** eventos `execution_started`, `executed`, `failed`
  (com `phase` e `rolled_back`), `approved`, `prepared`; falha antes do COMMIT
  reverte tudo e mantém a ação `approved` para retry.
- **Ações presas:** `dot_action_queue` com `status='approved'` pode ser
  reinvestigada; `executing` órfão exige intervenção operacional (o gateway não
  marca sucesso sem commit).
- **Scheduler:** lock durável por rodada; `last_error`, contadores de
  processadas/ignoradas/erros no status.
- **Rollback:** flags da seção 2; nenhum rollback apaga dados.
- **Banco:** backups/PITR do PostgreSQL antes de migrações e antes de ativar o
  monitor global.

---

## 6. Funcionalidades internas vs. dependentes de outbox/worker externo

Hoje o registro de ações (`services/dotActionRegistry.ts`) contém somente:

| Ação | Canal | Efeito externo | Executor |
|---|---|---|---|
| `priorizar_e_resolver` | `internal` | não | local |
| `escalar_responsavel` | `internal` | não | local |
| `corrigir_e_acompanhar` | `internal` | não | local |

O gateway rejeita `externalSideEffect=true` com "Ação externa exige executor
homologado pelo gateway". Portanto:

- **CRM, WhatsApp e e-mail externos NÃO podem ser habilitados** até existir
  outbox transacional + worker idempotente + contrato de retry/reconciliação.
- A execução atômica atual cobre apenas efeitos internos (caso, follow-up,
  status, auditoria) na mesma transação.
- Ao introduzir efeito externo, o desenho mínimo é: registrar intenção na
  mesma transação da aprovação/execução, worker com claim idempotente, chave de
  idempotência por ação, dead-letter e reconciliação; nunca chamar o provedor
  dentro da transação.
- Até lá, não habilitar canais externos nem `externalSideEffect`.

---

## 7. Checklist antes da ativação integral

- [ ] deploy aprovado do pacote com `@hono/node-server@2.1.6` e lockfile;
- [ ] `npm audit` e `npm audit --omit=dev` em 0 (validado localmente);
- [ ] backup/PITR do PostgreSQL de produção;
- [ ] migrações verificadas em staging (advisory lock, tabelas e índices);
- [ ] ausência de e-mails duplicados após `LOWER(TRIM(email))` verificada;
- [ ] `dot_budget_reservations` e índices do ledger presentes no staging;
- [ ] owner provisionado e auditado para cada empresa piloto;
- [ ] PIN definido e sessão administrativa validada;
- [ ] `FILTRA_DOT_ENABLED=1` com `FORCE_ON` desligado;
- [ ] `/api/health` e `/api/dot/status` saudáveis;
- [ ] rodada manual do monitor validada;
- [ ] worker de missões habilitado após a janela inicial;
- [ ] monitor global (`FILTRA_DOT_FORCE_ON=1`) somente após carga validada;
- [ ] política de retenção aprovada e job de expurgo definido;
- [ ] outbox/worker externo **não** habilitado nesta etapa.

## 8. Pendências remanescentes

1. Política de retenção formal e job de expurgo ainda não implementados.
2. `/api/dot/explain` também usa idempotência HTTP em namespace separado
   (`endpoint='/api/dot/explain'`), exige chave em produção e persiste/reproduz
   a resposta pelo mesmo serviço durável de idempotência. A rota foi conferida
   no HEAD atual de `routes/dotRoutes.ts`. A suíte HTTP existente cobre o
   contrato geral e o chat; acrescentar cenários específicos de replay/ambiguidade
   para explain continua sendo uma melhoria de cobertura, não uma ausência da
   proteção na implementação.
3. Integração legada do Deno Deploy deve ser removida do GitHub (required check
   obsoleto); o alvo de produção é Render. Detalhes em `DSV4`/relatório da
   missão: é um status externo do app Deno Deploy ("Organization suspended"),
   sem nenhuma referência no repositório.
4. Outbox/worker externo para CRM/WhatsApp/e-mail ainda não implementados —
   canais externos devem permanecer bloqueados.
5. Ativação das flags e provisionamento de owners são ações operacionais
   externas ao repositório e não foram executadas.
6. Monitor global e worker devem ser ligados de forma escalonada, com
   observação de carga.
7. Catálogo de alertas em `docs/DOT_OBSERVABILITY_ALERTS.md` está pronto, mas
   **nenhum alerta/canal está configurado ou ativo** em nenhuma plataforma.

## 9. Estado verificado em 13/11/2026

- Backend PR #144 HEAD `b7d1f4cf0854a17a9d67abfece8bb714743b148e`: Backend CI e dependency audit concluídos com sucesso nos runs listados acima.
- Frontend PR #203 HEAD `2438974495ee32d9bc1d015a5cf6f4eb6a44c0f7`: CI, dependency audit e Browser E2E concluídos com sucesso; E2E com mocks não substitui integração real.
- Render `filtra-ia-api` permanece no commit de produção anterior (`feac3cd6e3ccd757c81a706b45e594d6be22a5cd`), plano Free, serviço live. Nenhum deploy do PR #144 foi executado.
- Supabase produção: `dot_budget_reservations` e `dot_http_idempotency` presentes com RLS; `reservation_id` e `attempt_id` presentes; índices de idempotência verificados. Nenhum grant direto para `anon` ou `authenticated` nas duas tabelas privadas.
- Revisão independente de mantenedor ainda não registrada. A integração E2E backend + frontend + banco em ambiente controlado e a confirmação do canal externo de alertas continuam pendentes.
- DOT continua desativado; não ativar flags nem executar chamadas de IA até fechar os bloqueios acima.
