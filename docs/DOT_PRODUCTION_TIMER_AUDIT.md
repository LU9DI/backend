# Auditoria operacional do Filtra Dot em produção (DSV4 Missão 4)

> Executada em 2026-11-11 somente com **evidência pública de leitura** e análise
> do código no branch de produção. Não houve deploy, alteração de variável,
> migração, ativação de flag nem chamada a provedor. Acesso ao painel/API do
> Render e ao banco Supabase **não estava disponível**.

## 1. Identificação do build implantado

| Evidência | Resultado | O que delimita |
|---|---|---|
| `GET /api/dot/status` (anônimo) | **200**, corpo com `scheduler` e `worker` | rota montada; campo `worker` existe desde `a3c271e` (2026-10-17), que já contém o gate `FILTRA_DOT_FORCE_ON` (desde `00a6faa`, 2026-10-05) |
| `GET /api/dot/status` com `FILTRA_DOT_ENABLED` desligado (código master) | responderia **403** | como responde 200, no build implantado a flag está **ligada** |
| `GET /api/health` | 200 **sem** bloco `dot` | build **anterior** ao PR #144 (que adiciona o bloco) |
| `GET`/preflight com origem bloqueada | **200/404 sem** cabeçalho CORS | comportamento pós-`#147` (antes era 500); `#147` = `feac3cd`, 2026-11-11, presente **somente em `origin/master`** |
| Formato de `scheduler`/`worker` | igual ao master (`tick_ms`, `disabled`, `running`, sem `in_flight`) | corresponde ao master, não ao PR |
| `GET /api/live` `build.marker` | `reviews-unidade-v1` (hardcoded) | não identifica commit por si só |

**Conclusão:** o build corresponde ao **master `feac3cd`** (ou posterior; não há
posterior no master) — correspondência de alta confiança por fingerprint de
comportamento. Branch/imagem e **data do deploy não puderam ser verificadas**
(sem deploy history do Render). O processo observado iniciou às
`2026-11-11T22:34:37Z` por **cold start** (ver §2.6), não por deploy.

## 2. Timers, schedulers e workers

### 2.1 Boot e condições

No master (`server.ts`):

```ts
if (dotRuntimeEnabled()) {            // FILTRA_DOT_ENABLED === '1'
  mountDotRoutes(app); ... startDotMonitorScheduler(); startDotAgentWorker();
} else {
  app.get('/api/dot/status', ... 403);
}
```

- `startDotMonitorScheduler()` inicia a rodada imediata e um `setInterval`
  **somente** com `FILTRA_DOT_ENABLED=1` **e** `FILTRA_DOT_FORCE_ON=1`.
- `startDotAgentWorker()` inicia o tick e o timer quando chamado e
  `DOT_AGENT_WORKER_ENABLED != '0'`.
- Outros jobs do processo (fora do Dot): retry queue, acquisition worker,
  relatório mensal. Não fazem parte desta auditoria.

### 2.2 Estado observado em produção

| Campo | Valor observado |
|---|---|
| `scheduler.timer_active` | **true**, `tick_ms=300000` |
| `scheduler.last_run_at` | `22:34:47Z` → `22:39:47Z` (avançou exatamente +5 min) |
| `scheduler.companies_processed` / `skipped` / `errors` | **0 / 0 / 0** |
| `scheduler.followups_processed` / `events` / `decisions` / `actions` | **0 / 0 / 0 / 0** |
| `scheduler.duration_ms` | ~700 ms |
| `worker.timer_active` / `running` / `disabled` | **true / false / false** |
| `GET /api/dot/preferences`, `/agent/permissions`, `/agent/missions` (sem token) | **403 “Autenticação necessária.”** |

Interpretação: os timers **estão ativos porque as duas flags estão ligadas** —
não por bypass do gate. Nenhuma empresa entrou na rodada (`processed=skipped=0`
em todas as amostras), então o monitor **não criou eventos/decisões/ações**.

### 2.3 Respostas objetivas

1. **Inicializados no boot?** Sim: scheduler e worker sobem quando as flags
   permitem; a primeira rodada é imediata.
2. **Condições de execução:** `FILTRA_DOT_ENABLED=1` (rotas/timers) +
   `FILTRA_DOT_FORCE_ON=1` (scheduler) + `DOT_AGENT_WORKER_ENABLED != '0'`
   (worker).
3. **`FILTRA_DOT_ENABLED` é verificado em todos os caminhos?** No master, sim
   para montagem de rotas e início dos timers; **não** dentro de
   `startDotAgentWorker`/`wakeDotAgentWorker`, que dependem do wiring do boot.
   No PR #144 foi adicionada uma segunda barreira (ver §5).
4. **Timer pode executar com o Dot desabilitado?** No master, pelo boot, não.
   Em produção ambos os gates estão ligados (inferência de §1/§2.2), então os
   timers executam **porque o Dot está habilitado**.
5. **Pode ocorrer chamada a provedor?** Pelos timers **não**: scheduler,
   monitor, follow-ups, mission runner e context não importam `callAI`; o
   monitor é determinístico (“nada é executado aqui”). Chamadas de IA existem
   apenas nos endpoints HTTP `chat`/`explain` e em `dotModelRouting`, atrás do
   gate de autenticação/plano.
6. **Reserva/liquidação/consumo de orçamento pelos timers?** Não. O ledger
   durável nem existe no master; os timers só leem/escrevem tabelas do Dot.
7. **Duplicação entre instâncias?** Scheduler: lock durável `dot:scheduler`;
   monitor: lock por empresa; missões: lock por missão; ações: índice único
   parcial. O **chat HTTP** usa reserva **em memória por processo** (TTL 30 s),
   que não coordena instâncias — risco de estouro de cota com múltiplas
   instâncias (§3).
8. **Shutdown impede novas execuções e drena?** **Não no master**: o
   `gracefulShutdown` fecha HTTP e o banco e força saída em 25 s, sem parar
   scheduler/worker. O drain existe apenas no PR #144 (commit `932a2d0`, não
   presente no master).
9. **Diferença build antigo × PRs?** O PR #144 adiciona ledger durável,
   idempotência HTTP, estados ambíguos, drain de shutdown, observabilidade e
   gate duplo do worker; o frontend #203 adiciona `/dot/conversa`, que em
   produção responde **404** (não publicado).

### 2.4 Matriz de cenários (master implantado)

| Cenário | Scheduler | Worker | Provedor | Orçamento | Observação |
|---|---|---|---|---|---|
| DOT desabilitado (`FILTRA_DOT_ENABLED≠1`) | não inicia (403 no status) | não inicia | não | não | boot não monta rotas/timers |
| DOT habilitado, `FORCE_ON≠1` | **não inicia** | inicia (se wiring) | não pelos timers | não | só HTTP autenticado |
| DOT habilitado + `FORCE_ON=1` (produção observada) | inicia a cada 5 min | inicia a cada 5 min | não pelos timers | não pelos timers | rodadas com 0 empresas |
| Reinício/cold start | primeira rodada imediata; depois a cada 5 min | idem | não | não | processo dorme por inatividade (inferido) |
| Múltiplas instâncias | lock durável evita rodada dupla | lock por missão | não | chat pode estourar cota (reserva em memória) | 1 instância observada |
| Falha de banco | rodada falha e é registrada; timer continua | tick falha e tenta de novo | não | não | erros em log da plataforma (sem acesso) |

## 3. Segurança financeira

- **Reserva antes do provedor:** no master, `/api/dot/chat` e `/explain` fazem
  `checkDotTokenBudget` **antes** de `callAI` e **negam com 429** sem chamar o
  provedor quando o saldo é insuficiente. A reserva é **em memória**
  (`dotTokenReservations`, TTL 30 s, por processo), não durável.
- **Idempotência:** **não existe** no master. Retry do cliente/duplo clique
  pode gerar duas chamadas e dois consumos; concorrência entre instâncias pode
  estourar a cota em até uma resposta por instância.
- **Isolamento por tenant:** gate único (`resolveDotGate`) exige token,
  assinatura ativa e plano rei/corporativo; demo só fora de produção; cache
  semântico tem `empresa_id` na chave/`WHERE`; locks por empresa. Não foi
  encontrado caminho anônimo.
- **Crash:** reserva em memória é perdida (subcontrole temporário); consumo é
  gravado após a resposta; sem estado ambíguo no master, um timeout após o
  provedor pode ser repetido pelo cliente (cobrança dupla).
- **Saldo insuficiente:** 429 `DOT_TOKEN_LIMIT`, sem chamada ao provedor
  (fail-closed também quando a leitura da cota falha).
- **Background:** não há chamada a provedor nem consumo de orçamento.

## 4. Controles de produção (somente leitura)

| Verificação | Situação |
|---|---|
| `/api/live`, `/api/ready`, `/api/health` | 200; `db_ok:true`; AI com groq/gemini configurados |
| `/api/metrics` sem token | 401 (proteção ativa) |
| CORS | allowlist funcionando; origem desconhecida sem cabeçalho |
| Instâncias | **1** observada (`started_at` idêntico em 5 amostras) |
| Scheduler/worker | ativos; rodadas a cada 5 min com 0 empresas; worker ocioso |
| Logs | **inacessíveis** (sem Render) |
| Variáveis (nomes/valores) | **inacessíveis**; flags inferidas por comportamento |
| Deploy history / branch / imagem | **inacessíveis** |
| Banco (schema, reservas) | **inacessível** (sem Supabase) |
| Reinício de 22:34Z | **cold start** (uptime 68 s na primeira leitura); causa exata não verificável |

## 5. Correção fora da produção (PR #144)

Nenhum caminho de execução indevida foi comprovado no build implantado, mas a
auditoria expôs que os timers dependem apenas do wiring do boot. No branch do
PR #144 (não implantado) foram adicionadas duas barreiras e testes:

- `dotSchedulerRuntimeEnabled()` — scheduler só roda com `FILTRA_DOT_ENABLED=1`
  **e** `FILTRA_DOT_FORCE_ON=1`;
- `dotWorkerRuntimeEnabled()` — worker (start e wake) só roda com
  `FILTRA_DOT_ENABLED=1` e `DOT_AGENT_WORKER_ENABLED != '0'`;
- `tests/dotTimerGates.test.ts` — 6/6 cobrindo predicados, ausência de timer
  sem flags e drain ao parar.

Nenhuma alteração em produção foi feita.

## 6. Achados

| # | Achado | Severidade |
|---|---|---|
| F1 | Dot **habilitado em produção** (`FILTRA_DOT_ENABLED=1` + `FILTRA_DOT_FORCE_ON=1`), timers ativos, contrariando o checklist que assumia Dot desligado | **crítico (governança)** |
| F2 | Build implantado sem ledger durável/idempotência; reserva de cota em memória (30 s) → retry/concorrência podem **cobrar duas vezes** | **alto** |
| F3 | Shutdown do master não drena scheduler/worker (PR corrige) | **médio** |
| F4 | `/api/dot/status` público expõe estado de scheduler/worker | **baixo** |
| F5 | Scheduler/worker rodam com 0 empresas; nenhuma chamada a provedor ou consumo observado | **informativo** |
| F6 | Instância hiberna por inatividade (cold start observado); timers só rodam acordados | **médio (monitoração)** |

## 7. Decisão

# **EXIGE CONTENÇÃO OPERACIONAL**

Motivo: **não foi comprovada execução indevida nem consumo financeiro não
autorizado** pelos timers — eles são determinísticos, não chamam provedores e
estão processando zero empresas. Porém, a produção está em um estado
**habilitado** (`FILTRA_DOT_ENABLED=1` e `FILTRA_DOT_FORCE_ON=1`) que o plano de
ativação documentado tratava como desligado, e o build implantado não tem o
ledger/idempotência do PR #144. A contenção (desligar as flags) é ação
administrativa **não executada** por falta de autorização/acesso; até que o
proprietário confirme a intenção, o estado deve ser tratado como não aprovado.

Condições para encerrar a contenção:

1. confirmar no Render (branch, env, deploy history) se a ativação foi
   intencional e desde quando;
2. se não foi: remover `FILTRA_DOT_FORCE_ON` e `FILTRA_DOT_ENABLED`
   (autorização explícita), reiniciar e validar `/api/dot/status` = 403 e
   timers inativos;
3. se foi intencional: aceitar formalmente F2–F4 e manter o ledger do PR #144
   como pré-requisito para escalar/uso pleno;
4. manter a instância única até o ledger durável estar implantado;
5. ativar observabilidade/alertas (A1–A12) para cobrir F6.

## 8. Fechamento da Missão 5 (contenção e preparação)

**Intenção da habilitação:** não há registro de aprovação; pelo contrário,
`docs/DOT_PRODUCAO.md` §2 instrui “manter `FILTRA_DOT_FORCE_ON` desligado até
validar carga/idempotência/recuperação em produção” e o checklist de ativação
está “preparado, não aplicado”. Logo, a presença das flags **não** representa
aprovação.

**Contenção:** procedimento exato em
`docs/DOT_PRODUCTION_CONTAINMENT_RUNBOOK.md`, com ferramenta somente leitura
`scripts/dot-containment-check.ts` (`--expect disabled`). Execução do script
contra produção em 2026-11-11:

```json
{"expect":"enabled","ok":true,"summary":{"live_status":200,"health_status":200,
 "dot_status_status":200,"dot_status_enabled":false,
 "scheduler_timer_active":true,"worker_timer_active":true,"preferences_status":403}}
```

e, para `--expect disabled`, exit **1** com os problemas esperados (status 200,
timers ativos, preferences 403) — confirmando que a contenção ainda **não** foi
aplicada.

**Correção técnica:** `8ae072f` está no PR #144 (HEAD anterior a este commit);
os 6 testes de `tests/dotTimerGates.test.ts` passam, e todos os pontos de
start/wake do código de produção estão em `server.ts` dentro do bloco
`FILTRA_DOT_ENABLED=1`; o shutdown do PR drena scheduler e worker antes de
fechar o pool. Nenhuma rota monta timers por conta própria.

**Financeiro:** revisão em `docs/DOT_FINANCIAL_CONTROLS.md` — chat com
idempotência + ledger; `explain` com ledger e **sem** idempotência; background
sem consumo; contadores não são usados como proteção.
