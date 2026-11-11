# DSV4 Missão 2 — pacote de revisão humana (PRs #144 e #203)

> **Status da revisão:** pendente. Nenhum revisor foi solicitado
> (`requested_reviewers` vazio nas duas PRs) e **não existe aprovação humana
> registrada**. Este documento organiza o material para revisão independente;
> não substitui nem simula uma aprovação.

## 1. Estado das PRs (verificado em 2026-11-10)

| | Backend | Frontend |
|---|---|---|
| Repositório | `LU9DI/backend` | `LU9DI/saas-reputacao-ia` |
| PR | [#144](https://github.com/LU9DI/backend/pull/144) | [#203](https://github.com/LU9DI/saas-reputacao-ia/pull/203) |
| Título | feat(dot): reconcile durable ledger and production safeguards | feat(dot): add authenticated conversation interface |
| Base ← head | `master` ← `reconcile/dot-production-2026-11-06` | `main` ← `feat/filtra-dot-conversation` |
| HEAD | `e3ece99c09e49476d60305a1c025304ef2b7aa15` | `7ac6e043febde7f67c77423038b4ffd32d547a5a` |
| Commits / arquivos | 87 / 115 (+15.427 −970) | 9 / 1 (+850 −0) |
| `mergeable` | `true` (`unstable`) | `true` (`clean`) |
| Check runs | `test`, `audit`, `postgres-concurrency`: success | 12 check runs: success (inclui backend/typecheck e Vercel) |
| Status externo | `deploy/lu9di/filtra-ai-api-fallback`: **failure** (Deno Deploy, org suspensa) | `Vercel`: success |
| Reviews / revisores solicitados | 0 / nenhum | 0 / nenhum |

O estado `unstable` da #144 vem **exclusivamente** do status do Deno Deploy
(seção 7). Os jobs do GitHub Actions passam no HEAD informado.

## 2. Arquitetura do fluxo `/api/dot/chat`

1. Rate limit (`30/min`) e CSRF de header (`X-Dot-Csrf`) aplicados antes de
   autenticar mutações (`routes/dotRoutes.ts`).
2. `resolveDotAccess`: identifica empresa/usuário do JWT e o plano
   (`rei`/`corporativo`). Sem plano válido → 403 `DOT_PLAN_REQUIRED`.
3. Em produção exige `Idempotency-Key` válido (`^[A-Za-z0-9._:-]{16,128}$`).
4. Claim atômico em `dot_http_idempotency` (índice único
   `(empresa_id, idempotency_key)`): `claimed`, `replay`, `in_progress`,
   `ambiguous` ou `key_reused` (`services/dotHttpIdempotency.ts`).
5. Contexto e cache: cache factual e cache semântico podem responder sem
   consumir IA.
6. Reserva durável (`services/dotLedger.ts`): verifica saldo e limita a
   resposta por `response_limit`.
7. `markDotReservationSent` **antes** do provedor; falha → 503 sem chamada.
8. `callAI` com failover Groq → Gemini (`groqService.ts`).
9. `finalizeDotReservation`: grava `ai_usage` com tokens reais e fecha a
   reserva na mesma transação.
10. `persistDotHttpResponse`: grava a resposta **antes** de enviá-la;
    classificação por status conforme seção 3.

O frontend (`frontend/src/app/dot/conversa/page.tsx`) gera a chave por mensagem
lógica, persiste chave + payload no outbox **antes** do POST e reutiliza ambos em
retry/failover/reload.

## 3. Contrato de idempotência HTTP

| Estado persistido | Quando | Próxima requisição com a mesma chave |
|---|---|---|
| `processing` | claim recém-criado ou retry de `failed_safe` | `in_progress` (409, `Retry-After: 2`) |
| `completed` | status < 500 e ≠ 429, com corpo persistido | replay do status/corpo originais |
| `failed_safe` | 429 ou 5xx **sem** tentativa ao provedor | novo claim permitido (retry seguro) |
| `ambiguous` | 5xx com provedor tentado, corpo > 256 KB, claim perdido ou lease vencido (15 min) | 409 `DOT_REQUEST_AMBIGUOUS` até reconciliação |

Invariantes:
- a chave nunca vem do corpo; é escopada por `empresa_id` do token;
- payload diferente com a mesma chave → 409 `DOT_IDEMPOTENCY_KEY_REUSED`;
- retenção: `completed` 24 h; `failed_safe` 30 dias; `processing`/`ambiguous`
  nunca são apagados automaticamente;
- falha ao persistir a resposta → 503, nunca sucesso.

## 4. Transições financeiras (ledger)

| Operação | Efeito | Idempotência |
|---|---|---|
| `reserveDotExecution` | insere reserva `pending` com teto `tokens_reserved`; calcula uso + reservas sob advisory lock por empresa | bloqueia se saldo < teto (429 `DOT_TOKEN_LIMIT`) |
| `markDotReservationSent` | grava `sent_at` antes do provedor | UPDATE condicional `status='pending'` |
| `finalizeDotReservation` (sucesso) | insere `ai_usage` (tokens reais) e marca `settled` na MESMA transação | reserva já `settled` devolve duplicado sem novo consumo |
| `finalizeDotReservation` (ambíguo) | `ambiguous=1`, sem consumo; orçamento continua comprometido | não libera pelo relógio |
| `releaseDotReservation` | `released`, tokens 0 | só com `provenNotSent=true` |
| `sweepExpiredDotReservations` | `pending` sem `sent_at` vencida → `expired`; com `sent_at` além da carência → `ambiguous` | UPDATEs condicionais de uma instrução |

O teto da reserva nunca é debitado como consumo; o consumo é o real (in+out)
quando o provedor informa, senão a estimativa explícita.

## 5. Migrações

Fonte única: `lib/migrations.ts` (`initDB`), idempotente por DDL `IF NOT EXISTS`
e advisory lock `PG_MIGRATION_LOCK_KEY`. Tabelas do Dot:
`dot_budget_reservations`, `dot_http_idempotency`, `dot_action_queue`,
`dot_action_audit`.

Índices críticos:
- `ux_dot_http_idempotency_empresa_key` UNIQUE `(empresa_id, idempotency_key)`;
- `ux_dot_budget_reservations_ai_usage` UNIQUE parcial (consumo único por
  reserva);
- índices de tenant/expiração e de execução do ledger.

Evidência em PostgreSQL 17.11 descartável (não produção):
aplicação 2× com digest idêntico (`01744af975c03a5b…`), backup/restore com
schema idêntico, falha injetada no meio da migração e retomada íntegra
(`scripts/staging-migration-check.ts`, log em
`staging/logs/migration-check.log`).

## 6. Isolamento multi-tenant

- Toda consulta do ledger e da idempotência filtra `empresa_id` do JWT
  (`dotIdempotencyTenant`), nunca do corpo.
- Reservas: `lockDotBudget` (advisory lock por empresa) serializa
  reserva/liquidação entre processos; teste `dotLedgerRace.pg.test.ts` cobre
  corrida entre instâncias e tenant alheio.
- Idempotência: índice único por `(empresa_id, key)`; replay só no mesmo
  tenant.
- Frontend: chaves de storage escopadas por hash de `empresa_id|id` do JWT
  (`tokenScope`), evitando vazamento entre contas no mesmo navegador.

## 7. Check externo `deploy/lu9di/filtra-ai-api-fallback`

- É um **commit status** (não check run) do app **Deno Deploy**, descrição
  “Organization suspended - resolve billing to deploy”.
- Não há workflow, script ou configuração no repositório que crie esse status.
- `branches/master/protection` → 404 e `rulesets` vazio: **não existe required
  check**. O status não bloqueia merge tecnicamente; apenas deixa a PR
  `unstable`.
- Correção recomendada (administrativa, fora do código): desinstalar/desativar
  a integração Deno Deploy para o repositório (GitHub → Settings →
  Integrations/GitHub Apps) ou remover o projeto Deno que publica o status. Não
  desativar proteções nem remover required checks sem autorização.

## 8. Render (produção)

- Serviço conhecido: `filtra-ia-api`, id `srv-dafc88ad0e5s73bqgfm0`,
  `https://filtra-ia-api.onrender.com`, health `/api/live`.
- **Não houve acesso ao painel/API do Render nesta missão** (nenhuma variável
  `RENDER_*` no ambiente; sem token). Configuração privada (autoDeploy,
  variáveis, plano, disco, região) **não foi inspecionada**.
- Checklist e lista de acessos necessários: `docs/DOT_RENDER_ACTIVATION_CHECKLIST.md`.

## 9. Testes relevantes (executados nesta missão)

| Suíte | Resultado |
|---|---|
| `tests/observability.test.ts` (novo) | 8/8 |
| `tests/dotLedger.pg.test.ts` | 6/6 |
| Suíte PostgreSQL completa (`npm run test:postgres`, 41 testes) | 40/41 na 1ª execução; **1 falha real de infraestrutura de teste** causada pelos novos logs JSON em stdout, corrigida em `tests/helpers/pg-test-utils.ts`; reexecução do arquivo afetado 6/6; reexecução completa no fechamento (ver relatório final) |
| E2E `/dot/conversa` (Playwright, 19 testes cobrindo os 15 cenários) | **19/19 aprovados em duas execuções consecutivas** contra build de produção (`next start`), com todas as bases do failover interceptadas |
| Suíte E2E completa do frontend (`npx playwright test`, inclui GA4/smoke) | 25 aprovados, 1 ignorado por configuração (`E2E_REVIEW_URL`); 1 flake **pré-existente e não relacionado** em `analytics.spec.ts:84` (ver nota) |
| `tsc --noEmit` backend | 0 erros |
| `tsc --noEmit` frontend | 0 erros |
| `eslint .` frontend | 0 erros (108 avisos pré-existentes) |
| `npm audit --omit=dev` (backend e frontend) | 0 vulnerabilidades |

Notas de fidelidade dos testes:

- O bloqueio do service worker (`test.use({ serviceWorkers: 'block' })`) foi
  aplicado **somente** em `e2e/dot-conversa.spec.ts`: depois do primeiro
  carregamento o `PwaRegister` faz o SW intermediar os fetches e o
  `page.route` deixa de interceptá-los, o que tornava os mocks ineficazes e
  permitia chamada real. O SW **não** cacheia `/api/dot/*` (fora da allowlist
  de `public/sw.js`).
- `analytics.spec.ts:84` falhou de forma intermitente nas execuções locais
  (1 a cada 3) ao contar `/gtag/js` após um `page.goto` completo; o arquivo
  **não foi alterado** nesta missão e o mesmo teste está verde na `main`
  (run 42931100993). Flake registrado, fora do escopo do Dot.
- A falha inicial dos 19 testes (regex de mock com `/5000` em vez de `:5000` e
  o SW assumindo o controle após `reload`) foi diagnosticada e corrigida no
  próprio spec; nenhum mock foi relaxado e a base de produção
  (`https://api.filtraai.com`) permanece bloqueada em todos os testes.

A suíte completa foi reexecutada após a correção; resultado no relatório final
da missão (sem omitir a falha intermediária).

## 10. Observabilidade adicionada (backend)

- Contexto por requisição (`AsyncLocalStorage`) com `X-Request-Id` saneado e
  `empresa_id` após autenticação (`lib/observability.ts`).
- Eventos JSON com redação de credenciais/conteúdo; testes dedicados.
- Contadores em `/api/metrics` (protegido) e estado do scheduler/worker.
- Catálogo de alertas em `docs/DOT_OBSERVABILITY_ALERTS.md` — **nenhum alerta
  configurado ou ativo**.

## 11. Riscos residuais

1. `/api/dot/explain` não usa idempotência HTTP (só o chat). Retry pode gerar
   nova reserva/chamada; o frontend de conversa não usa esse endpoint.
2. Histórico de conversa (`sessions`) é `Map` em memória por processo: em
   múltiplas instâncias o histórico não é compartilhado (o frontend mantém a
   própria cópia; o servidor usa para contexto imediato).
3. Contadores e latências são por processo e zeram no deploy.
4. Retenção/expurgo de auditoria ainda é manual.
5. Alertas recomendados não estão ativos.
6. PR #144 mistura refatorações de banco (pool, migrações), aquisição e
   autenticação além do Dot — a revisão humana deve considerar esse escopo
   amplo (115 arquivos).
7. Status externo Deno precisa de ação administrativa (seção 7).

## 12. Rollback

- Dot desligado por `FILTRA_DOT_ENABLED=1` (padrão: ausente ⇒ rotas nem
  montadas). Desligar a flag é o kill switch; não apaga dados.
- Migrações são aditivas/idempotentes; rollback de schema não é necessário para
  desativar o Dot (tabelas permanecem).
- Frontend pode reverter a PR #203 sem dependência de backend (rota isolada).
- Reservas ambíguas exigem reconciliação manual (`DOT_PRODUCTION_READINESS.md`
  §2.5); desligar a flag não as libera.

## 13. Roteiro sugerido para o revisor humano

1. `services/dotHttpIdempotency.ts`: unicidade e transições (seção 3).
2. `services/dotLedger.ts`: transação de liquidação, `FOR UPDATE`, sweep.
3. `routes/dotRoutes.ts` `/api/dot/chat`: ordem claim → cache → reserva →
   marca → provedor → finalize → persistência da resposta.
4. `lib/migrations.ts`: DDL das três tabelas do Dot e índices únicos.
5. `frontend/src/app/dot/conversa/page.tsx`: outbox, classificação de erros,
   escopo de storage.
6. `e2e/dot-conversa.spec.ts`: cenários e mocks.
7. Rodar: `npm test`, `npm run test:postgres` (DB descartável),
   `npx playwright test` (frontend).

A aprovação deve ser registrada por um revisor independente na própria PR
(“Approve”). Este pacote não registra aprovação.
