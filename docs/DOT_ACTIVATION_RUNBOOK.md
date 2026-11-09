# Filtra Dot — runbook de ativação e rollback

**Status:** preparação. Nenhuma flag foi ativada e nada foi publicado.
**PR:** #144 — `reconcile/dot-production-2026-11-06`
**Documento irmão:** [`DOT_PRODUCTION_READINESS.md`](DOT_PRODUCTION_READINESS.md)

Este runbook é o procedimento operacional para ativar o Dot de forma gradual,
validar o fluxo real e desligá-lo com segurança. Ele não substitui a revisão
independente, o CI verde nem a validação em staging.

---

## 1. Pré-condições obrigatórias

- [ ] commit aprovado e CI da PR verde (build, SQLite, PostgreSQL);
- [ ] `npm audit` e `npm audit --omit=dev` em 0;
- [ ] staging com PostgreSQL real, backup/PITR e migração de boot validados;
- [ ] owner de cada empresa piloto provisionado e auditado;
- [ ] frontend atualizado para enviar `X-Dot-Csrf: 1` nas mutações de empresa;
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

- `/api/health` e `/api/dot/status`;
- logs `[dot-scheduler]`, `[dot]`;
- auditoria `dot_action_audit` (`prepared`, `approved`, `execution_started`,
  `executed`, `failed` com `phase`/`rolled_back`);
- alertas a definir: `failed` acima de limiar, ação presa em `executing`,
  auditoria de execução duplicada, erro de scheduler, fila `approved` antiga;
- retenção de auditoria conforme política aprovada; nenhum expurgo automático
  está implementado. A CLI `scripts/dot-audit-retention.ts` é manual
  (dry-run/export por padrão); expurgo exige `--purge --yes` e
  `DOT_AUDIT_RETENTION_CONFIRM=1`, após backup e aprovação, e deixa registro
  em `audit_logs`.

## 6. Critérios de abortar a ativação

- CI ou smoke de staging falhando;
- frontend sem `X-Dot-Csrf` nas mutações;
- owner/PIN não provisionados;
- migração sem backup ou com lock suspeito;
- ação executada sem aprovação, aprovador igual ao preparador sem owner, ou
  vazamento entre empresas;
- auditoria ausente/inconsistente;
- erro repetido em worker/monitor sem rollback seguro.

Em qualquer um desses casos, aplicar o kill switch e registrar o incidente.
