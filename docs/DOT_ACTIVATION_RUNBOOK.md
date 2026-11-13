# Filtra Dot — runbook de ativação e rollback

**Status:** preparação. Nenhuma flag foi ativada e nada foi publicado.
**PR:** #144 — `reconcile/dot-production-2026-11-06`
**HEAD publicado:** `c890c9ae9b80c641c34d7546786ab3c617eab252` (idempotência HTTP,
drenagem de workers e failover final **não publicados** — estão em commits
locais sobre esse HEAD)
**Documento irmão:** [`DOT_PRODUCTION_READINESS.md`](DOT_PRODUCTION_READINESS.md)

Este runbook é o procedimento operacional para ativar o Dot de forma gradual,
validar o fluxo real e desligá-lo com segurança. Ele não substitui a revisão
independente, o CI verde nem a validação em staging.

---

## 0. Evidências técnicas desta revisão (2026-11-08)

- **CI (GitHub Actions):** `test`, `postgres-concurrency` e `audit` verdes no
  HEAD publicado.
- **Check externo `deploy/lu9di/filtra-ai-api-fallback`:** status **legado do
  Deno Deploy** (`console.deno.com`), com a organização suspensa por
  faturamento. **Não é o serviço de produção** — a API do Dot roda em
  **Render**. Ação: remover a integração/required check obsoleta do Deno no
  GitHub; **não** alterar o Render para “fazer o check passar”.
- **Testes locais (HEAD + correções no working tree):** `tsc --noEmit` 0;
  suíte SQLite **444/444**; suíte PostgreSQL **37/37**; `npm audit` e
  `npm audit --omit=dev` **0 vulnerabilidades**.
- **Ledger:** a corrida `sweepExpiredDotReservations` × `finalizeDotReservation`
  foi corrigida (predicados de estado no `WHERE` externo impedem
  `settled → expired`); `markDotReservationSent` agora recusa reserva que não
  esteja `pending` (nada é enviado ao provedor sem transição durável); o
  `AggregateError` do failover preserva `status`/`code`/mensagem do erro final.
- **Migração de autenticação:** a normalização `LOWER(TRIM(email))` é aplicada
  nas consultas e há guarda de duplicados **antes** do índice único — se houver
  colisão, o boot falha fechado sem alterar usuários.
- **Idempotência HTTP do chat (contrato `DOT_HTTP_IDEMPOTENCY.md`):** claim
  durável em `dot_http_idempotency` antes de contexto, cache, reserva e
  provedor; estados `processing`/`completed`/`ambiguous`/`failed_safe`; chave
  obrigatória em produção (400 `DOT_IDEMPOTENCY_KEY_REQUIRED`); unicidade por
  `(empresa_id, idempotency_key)`; replay do status/JSON originais; 409
  `DOT_REQUEST_IN_PROGRESS` / `DOT_REQUEST_AMBIGUOUS` /
  `DOT_IDEMPOTENCY_KEY_REUSED`; falha de persistência vira 503
  `DOT_IDEMPOTENCY_PERSIST_FAILED` (nunca sucesso não reproduzível).

---

## 1. Pré-condições obrigatórias

- [ ] commit aprovado e CI da PR verde (build, SQLite, PostgreSQL);
- [ ] `npm audit` e `npm audit --omit=dev` em 0;
- [ ] staging com PostgreSQL real, backup/PITR e migração de boot validados;
- [ ] ausência de e-mails duplicados após `LOWER(TRIM(email))` (a migração
      bloqueia o boot se existirem — ver seção 3.5);
- [ ] owner de cada empresa piloto provisionado e auditado;
- [ ] frontend atualizado para enviar `X-Dot-Csrf: 1` nas mutações de empresa;
- [ ] frontend `/dot/conversa` publicado e envia `X-Idempotency-Key` por
      mensagem lógica, com a mesma chave em retry/failover;
- [ ] todas as bases de API do failover apontam para o **mesmo** PostgreSQL
      (ver `DOT_PRODUCTION_READINESS.md` §2.4) — sem isso, o failover do chat
      pode executar a mesma mensagem duas vezes;
- [ ] revisão independente do diff concluída;
- [ ] janela de ativação e rollback acordados.

## 2. CSRF obrigatório nas mutações de empresa

Toda mutação em `/api/dot/*` (exceto `/api/dot/admin/*` e
`/api/dot/agent/*`, que têm gates próprios) exige um header customizado:

```http
X-Dot-Csrf: 1
```

`X-Dot-Admin: 1` é aceito como fallback para clientes administrativos
existentes. Requisições sem header retornam `403 DOT_CSRF_REQUIRED` antes de
autenticar. O frontend deve ser atualizado antes da ativação; cookie
`SameSite=None` sozinho não é proteção CSRF.

## 3. Sequência de ativação

### 3.1 Preparação

1. Confirmar backup do PostgreSQL de produção.
2. Confirmar migrações do boot em staging (advisory lock, tabelas e índices).
3. Provisionar owner para as empresas piloto (API de plataforma).
4. Definir PIN administrativo e validar `GET /api/dot/admin/state`.
5. Garantir `DOT_AGENT_WORKER_ENABLED=0` e `FILTRA_DOT_FORCE_ON` desligado.

### 3.2 Ligar o recurso sem varredura global

```text
FILTRA_DOT_ENABLED=1
DOT_AGENT_WORKER_ENABLED=0
FILTRA_DOT_FORCE_ON=<ausente ou 0>
```

Validar:

- `GET /api/health` → `ok:true`, banco ok;
- `GET /api/dot/status` → recurso habilitado, scheduler desligado;
- login, owner, PIN e administração;
- preparar → aprovar → executar uma ação interna de teste;
- conferir casos, follow-ups e `dot_action_audit`;
- confirmar que execução sem aprovação e aprovação pelo próprio preparador
  (sem owner) são bloqueadas;
- confirmar isolamento entre duas empresas de teste.

### 3.3 Worker de missões

Ligar `DOT_AGENT_WORKER_ENABLED` (ou remover `=0`) e observar o status.
Validar missão completa sem chamadas externas.

### 3.4 Monitor global (última etapa)

Somente após uma rodada manual aprovada (`POST /api/dot/monitor/run`) e
observação de carga:

```text
FILTRA_DOT_FORCE_ON=1
```

Acompanhar `dot-scheduler` (candidatos, processadas, erros, duração) e
auditoria. Não ligar CRM/WhatsApp/e-mail externos: dependem de outbox/worker
idempotente ainda não implementado.

### 3.5 Migração em staging (procedimento seguro)

Não executar migração em produção como parte da validação. O procedimento é:

1. **Backup/PITR** do banco de staging e janela aprovada.
2. **Checagem prévia de e-mails duplicados** (somente leitura):
   ```sql
   SELECT LOWER(TRIM(email)) AS normalized, COUNT(*) AS total
     FROM usuarios
    WHERE email IS NOT NULL
    GROUP BY LOWER(TRIM(email))
   HAVING COUNT(*) > 1;
   ```
   Qualquer linha exige correção **auditada** antes do deploy; a migração
   aborta o boot com `Migração de autenticação bloqueada` e não altera dados.
3. Rodar o boot da aplicação (ou `runCentralMigrations`) em staging e conferir
   no log: `Schema inicializado (migrações centrais idempotentes)`.
4. Validar objetos criados:
   ```sql
   SELECT indexname FROM pg_indexes
    WHERE tablename IN ('usuarios','ai_usage','dot_budget_reservations','dot_http_idempotency')
    ORDER BY indexname;
   ```
   Esperado: `ux_usuarios_email_normalized`, `ux_dot_budget_reservations_ai_usage`
   (parcial), `idx_ai_usage_feature`, os índices do ledger e
   `ux_dot_http_idempotency_empresa_key` (único por
   `(empresa_id, idempotency_key)`). A migração da tabela de idempotência
   **falha fechada** se o schema existente for incompatível (por exemplo, com a
   coluna legada `tenant_id`): o boot para e exige reconciliação manual — não
   degrada para "best effort".
5. Rodar uma segunda vez (idempotência) e conferir que não há DDL repetida nem
   erro; a suíte `dbPoolMaxOne.pg.test.ts` cobre esse caminho com
   `PG_POOL_MAX=1`.
6. Smoke: login com e-mail legado contendo espaços, `/api/health`,
   `/api/dot/status`, provisionamento de owner e PIN.

Impacto operacional: os índices são criados com `CREATE INDEX` (não
`CONCURRENTLY`) no boot; em tabelas grandes há uma janela curta de lock de
escrita. Executar em janela de baixa carga.

---

## 4. Kill switch e rollback

| Ação | Efeito |
|---|---|
| remover `FILTRA_DOT_ENABLED` e reiniciar | recolhe rotas do Dot; mantém dados |
| remover `FILTRA_DOT_FORCE_ON` e reiniciar | para somente o monitor global |
| `DOT_AGENT_WORKER_ENABLED=0` e reiniciar | para o worker de missões |
| revogar sessões/PIN | bloqueia administração sem apagar auditoria |
| restaurar backup PostgreSQL | recuperação de desastre; exige aprovação e janela |

Executar um drill em staging antes da produção. Nenhum rollback remove dados
de missões, decisões, ações, casos, follow-ups ou auditoria.

## 5. Observabilidade mínima

- `/api/health`, `/api/dot/status` e `/api/metrics` (contadores + scheduler +
  worker; protegido por `METRICS_TOKEN`/`JOBS_SECRET` em produção);
- correlação por `X-Request-Id` em toda resposta e nos logs JSON
  (`request_id`/`empresa_id`), conforme `DOT_OBSERVABILITY_ALERTS.md`;
- logs `[dot-scheduler]`, `[dot]`;
- logs `[dot-idempotency] requisição ambígua` e `[dot-idempotency] lease expirado
  promovido para ambíguo` (nenhum conteúdo de mensagem é registrado);
- auditoria `dot_action_audit` (`prepared`, `approved`, `execution_started`,
  `executed`, `failed` com `phase`/`rolled_back`);
- consulta de acompanhamento da idempotência e o procedimento de reconciliação
  em `DOT_PRODUCTION_READINESS.md` §2.5;
- alertas recomendados (nenhum configurado): `DOT_OBSERVABILITY_ALERTS.md` §5 —
  crescimento de erro, estados ambíguos, divergência reserva × consumo,
  orçamento, scheduler, health, provedor e banco;
- retenção de auditoria conforme política aprovada; nenhum expurgo automático
  está implementado. A CLI `scripts/dot-audit-retention.ts` é manual
  (dry-run/export por padrão); expurgo exige `--purge --yes` e
  `DOT_AUDIT_RETENTION_CONFIRM=1`, após backup e aprovação, e deixa registro
  em `audit_logs`.

## 6. Critérios de abortar a ativação

- CI ou smoke de staging falhando;
- e-mails duplicados após `LOWER(TRIM(email))` não corrigidos;
- frontend sem `X-Dot-Csrf` nas mutações;
- frontend do chat sem `X-Idempotency-Key` (o backend responderia 400 em
  produção) ou com chave nova a cada retry;
- bases de API do failover apontando para bancos diferentes (duplicação
  garantida em caso de failover do chat);
- owner/PIN não provisionados;
- migração sem backup ou com lock suspeito;
- ação executada sem aprovação, aprovador igual ao preparador sem owner, ou
  vazamento entre empresas;
- auditoria ausente/inconsistente;
- erro repetido em worker/monitor sem rollback seguro.

Em qualquer um desses casos, aplicar o kill switch e registrar o incidente.
