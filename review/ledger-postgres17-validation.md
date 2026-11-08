# Validação PostgreSQL 17 — Durable Token Ledger

Data: 2026-11-08
Repositório validado: `backend` (`C:\Users\lucas\backend-pr139-integration`)
Branch: `reconcile/dot-production-2026-11-06`
HEAD na validação original: `932a2d0bedfd21fb63c59779eda0451dd35165fd`
HEAD após a correção: `e8345a6b73689b369fe2f640a246a59819b02f68`
Branch documental: `audit/dot-ledger-2026-11-06`

---

## 0. Atualização pós-correção — commit `e8345a6` (estado atual)

**APROVADO.** A corrida `sweep` × `finalize` foi corrigida e revalidada no mesmo
PostgreSQL 17.11 descartável (locale C/UTF8, 127.0.0.1:55433):

| Validação | Resultado | Exit |
|---|---|---:|
| `dotLedger.pg.test.ts` | 6/6 | 0 |
| `dotExecutionAtomicity.pg.test.ts` | 5/5 | 0 |
| `dotActionConcurrency.pg.test.ts` | 2/2 | 0 |
| `dotLedgerRace.pg.test.ts` (novo) | 7/7 | 0 |
| `npm run test:postgres` | **35/35** (11 arquivos) | 0 |
| Teste #22 × 5 repetições | 5/5 | 0 |
| Suíte não-PG (SQLite) `npm test` | **431/431** | 0 |
| `npx tsc --noEmit` (Windows e WSL) | 0 erros | 0 |

Critérios obrigatórios: **0 consumo órfão, 0 duplicação, 0 transição
`settled → expired`, comportamento idempotente, todas as suítes PG aprovadas.**

Detalhes da correção, SQL anterior/corrigido e hashes: `review/ledger-postgres-race-fix.md`.
Logs novos: `review/pg17-logs/*-fixed.log`, `dotLedgerRace.log`, `sweep2-run-*.log`,
`test-postgres-fixed.log`, `sqlite-suite.log`.

---

## 1. Conclusão na validação original (histórico, antes da correção)

**BLOQUEADO** naquele momento.

A suíte PostgreSQL real rodou de ponta a ponta em um PostgreSQL 17.11 descartável
(locale C, UTF8): **28 testes, 27 aprovados, 1 falho, 0 ignorados**.

A falha é **determinística** (5/5 repetições) e é **defeito de código**, não de
ambiente: a corrida `sweepExpiredDotReservations` × `finalizeDotReservation`
deixa uma reserva `expired` com consumo (`ai_usage`) gravado — exatamente o
"consumo órfão" que o teste afirma ser impossível. Nenhuma alteração de
implementação foi feita; a correção proposta está na seção 9 e depende de
autorização.

---

## 2. Ambiente

| Item | Valor |
|---|---|
| Host de teste | WSL2 — Ubuntu 26.04.1 LTS, kernel `6.18.54.1-microsoft-standard-WSL2` (x86_64) |
| PostgreSQL | **17.11** (`17.11-1.pgdg26.04+2`, PGDG) em `/usr/lib/postgresql/17/bin` |
| Node (execução da suíte) | v22.22.1 (binário oficial Linux, `~/node`) |
| npm | 10.9.4 |
| Cluster | exclusivo, `~/pg17-disposable/data`, porta **55433**, `listen_addresses=127.0.0.1`, `unix_socket_directories=/tmp` |
| Locale / encoding | `datcollate = C`, `datctype = C`, `server_encoding = UTF8` (todos os bancos) |
| Usuário / banco de teste | `filtra_test` / `filtra_ledger_test` |
| Autenticação | `trust` restrito a loopback (`--auth-local=trust --auth-host=trust` + bind 127.0.0.1) |
| TimeZone | `America/Sao_Paulo` (não afeta instantes `TIMESTAMPTZ`) |
| Produção/staging | **nenhuma conexão**. Cluster criado do zero; nenhum banco pré-existente reutilizado |

Serviços PostgreSQL do Windows (`postgresql-x64-17`, `postgresql-x64-18`)
permaneceram **Stopped** e não foram tocados. A tentativa anterior de cluster
descartável no Windows falhou com `0xC0000142` (STATUS_DLL_INIT_FAILED), por isso
a validação seguiu no WSL2.

### Como a suíte foi executada

O `localhostForwarding` do WSL2 não estava funcionando (Windows → `127.0.0.1:55433`
= `ECONNREFUSED`). Para não enfraquecer o guard nem expor o cluster, a suíte foi
executada **nativamente dentro do WSL** (mesmo alvo do CI: Ubuntu + PG 17 locale C),
sobre uma cópia limpa e idêntica do HEAD:

```
git -C <repo> archive HEAD | tar -x -C ~/dot-test     # 332 arquivos
manifesto sha256(tests,services,lib,routes) = a958f3723ae48e2108c1424e20eaa8fc697eb4d250b58a50b225782f14261710
```

O repositório original permaneceu intocado: HEAD `932a2d0…`, `git status` limpo,
`stash@{0}` intacto. As dependências Linux foram instaladas com `npm ci`
(201 pacotes, 0 vulnerabilidades).

---

## 3. Conexão do projeto (guards preservados)

- `scripts/run-tests.mjs --postgres` → executa todos os `tests/**/*.pg.test.ts`
  com `node --import tsx --test --test-concurrency=1`.
- `assertSafeTestDatabaseUrl` aceita `localhost`, `127.0.0.1`, `::1`; outros hosts
  exigem `FILTERA_PG_TEST_ALLOWED_HOSTS`. **`127.0.0.1` foi usado; a allowlist NÃO
  foi necessária.**
- `createTestDatabase()` conecta em `/postgres` e cria/derruba bancos por teste;
  `dropTestDatabase()` usa `DROP DATABASE … WITH (FORCE)`.
- URL usada (sem senha, pois `trust` é local):
  `postgresql://filtra_test@127.0.0.1:55433/filtra_ledger_test`
  (o `dotLedger.pg.test.ts` cria seu próprio banco a partir dela).

Nenhuma proteção foi alterada: guard anti-produção, validação de host,
isolamento por banco e limpeza continuam ativos.

---

## 4. Evidência pré-teste

```
PostgreSQL 17.11 (Ubuntu 17.11-1.pgdg26.04+2) on x86_64-pc-linux-gnu
server_encoding = UTF8
datcollate = C   datctype = C   (filtra_ledger_test, postgres, template0/1)
listen: 127.0.0.1:55433
current_user @ endereço = filtra_test @ 127.0.0.1/32:55433
```

---

## 5. Resultados

### 5.1 Execução individual (ordem exigida)

| Arquivo | Testes | Pass | Fail | Exit |
|---|---:|---:|---:|---:|
| `tests/dotLedger.pg.test.ts` | 6 | 5 | **1** | **1** |
| `tests/dotExecutionAtomicity.pg.test.ts` | 5 | 5 | 0 | 0 |
| `tests/dotActionConcurrency.pg.test.ts` | 2 | 2 | 0 | 0 |

### 5.2 Suíte completa

```
npm run test:postgres      # 11 arquivos *.pg.test.ts
# tests 28 | # pass 27 | # fail 1 | # cancelled 0 | # skipped 0 | # todo 0
NPM_EXIT=1
```

Única falha:

```
not ok 22 - PostgreSQL: sweep e finalize concorrentes não deixam consumo órfão nem reserva reaberta
  tests/dotLedger.pg.test.ts:166
  AssertionError: Expected values to be strictly equal: true !== false
  expected: false   actual: true
```

### 5.3 Cenários multi-processo

Executados e **aprovados** (processos Node independentes, pools/conexões próprios):

- 3 processos inicializam o mesmo banco vazio sem erro de DDL (#4);
- 3 processos com `PG_POOL_MAX=1` sem deadlock (#6);
- 2 instâncias finalizando a mesma reserva → 1 único consumo (#20);
- 6 reservas concorrentes serializadas sem estourar o saldo (#21);
- 2 instâncias preparando/aprovando a mesma ação sem auditoria duplicada (#10, #11);
- 2 execuções concorrentes com um único vencedor (#14).

A falha #22 é concorrência **no mesmo processo** (`Promise.all` de
`finalize` + 2× `sweep`), não multi-processo.

---

## 6. Análise da falha

### 6.1 Sintoma medido

Probe isolado (banco próprio `filtra_probe`, mesma sequência do teste),
3 iterações:

```json
[
 { "iter": 1, "engine": "postgres", "finalize_ok": true,  "status_final": "expired", "ai_usage_rows": 1, "referencia_valida": 1 },
 { "iter": 2, "engine": "postgres", "finalize_ok": false, "reason": "reserva já expired", "status_final": "expired", "ai_usage_rows": 0 },
 { "iter": 3, "engine": "postgres", "finalize_ok": false, "reason": "reserva já expired", "status_final": "expired", "ai_usage_rows": 0 }
]
```

Repetição do teste #22 isolado: **5/5 execuções falharam** (`EXIT=1`).

Na iteração 1: `finalize` retornou `ok:true`, gravou `ai_usage` (1 linha) e
apontou `ai_usage_id`, mas o status final é **`expired`** — reserva expirada com
consumo registrado e referência válida. É inconsistência de estado (o orçamento
"reservado" deixa de contabilizar um consumo que existe).

### 6.2 Causa-raiz

`services/dotLedger.ts` → `sweepExpiredDotReservations` (linhas **667–675** e
**677–691**): o `UPDATE` externo filtra apenas `id IN (subquery)`; o estado
`status = 'pending'` está **somente dentro da subquery**.

```sql
-- atual (linha 667)
UPDATE dot_budget_reservations
   SET status = 'expired', updated_at = ?
 WHERE id IN (
   SELECT id FROM dot_budget_reservations
    WHERE status = 'pending' AND ambiguous = 0 AND expires_at <= ? AND sent_at IS NULL …
    ORDER BY id ASC LIMIT n
 )
```

Em PostgreSQL READ COMMITTED, quando o `UPDATE` externo encontra uma linha
bloqueada por `finalizeDotReservation` (`SELECT … FOR UPDATE`), ele **espera** o
commit e então **reavalia apenas o WHERE externo** — `id IN (subquery)`, que
continua verdadeiro. Resultado: o `UPDATE` sobrescreve `settled` → `expired`,
mantendo `tokens_real` e `ai_usage_id`. O mesmo padrão existe no segundo `UPDATE`
(`SET ambiguous = 1`), que pode marcar como ambígua uma reserva já finalizada.

O comentário do próprio código declara a intenção oposta ("`finalize` concorrente
que já mudou o status para `settled` faz o UPDATE atingir 0 linhas, e nada é
sobrescrito"), portanto a implementação viola seu contrato documentado.

Fatores descartados: ambiente correto (PG 17.11, C/UTF8, sem erro de DDL),
`dbEngine() = postgres` confirmado no probe, `FOR UPDATE`/advisory lock ativos
(os testes #20/#21 passam), nenhuma configuração enfraquecida.

### 6.3 Defeito secundário no `finalize`

Em `finalizeDotReservation` (≈ linha 566), quando o `UPDATE … WHERE status='pending'`
atinge 0 linhas, o código retorna `{ ok: true, duplicate: true }` **sem verificar o
status final**. Se a linha estiver `expired`, devolve sucesso e mantém a transação
(com o `ai_usage` já inserido) — é o caminho que produz o órfão observado.

---

## 7. Proposta de correção (NÃO aplicada)

Requer autorização; implicaria um novo commit sobre `932a2d0` (novo lote) e nova
execução completa.

1. **Guard de estado no WHERE externo** dos dois `UPDATE` de
   `sweepExpiredDotReservations`:

```sql
UPDATE dot_budget_reservations
   SET status = 'expired', updated_at = ?
 WHERE status = 'pending' AND ambiguous = 0 AND expires_at <= ? AND sent_at IS NULL{scope}
   AND id IN (
     SELECT id FROM dot_budget_reservations
      WHERE status = 'pending' AND ambiguous = 0 AND expires_at <= ? AND sent_at IS NULL{scope}
      ORDER BY id ASC LIMIT {max}
   )
-- params: [now, now, ...scopeParams, now, ...scopeParams]
```

```sql
UPDATE dot_budget_reservations
   SET ambiguous = 1, ambiguous_reason = ?, updated_at = ?
 WHERE status = 'pending' AND ambiguous = 0 AND sent_at IS NOT NULL
   AND expires_at <= ? AND sent_at <= ?{scope}
   AND id IN (
     SELECT id FROM dot_budget_reservations
      WHERE status = 'pending' AND ambiguous = 0 AND sent_at IS NOT NULL
        AND expires_at <= ? AND sent_at <= ?{scope}
      ORDER BY id ASC LIMIT {max}
   )
-- params: [reason, now, now, graceCutoff, ...scopeParams, now, graceCutoff, ...scopeParams]
```

2. *(Opcional, endurecimento)* na subquery, `… FOR UPDATE SKIP LOCKED`, para o
   sweep pular linhas já travadas por um `finalize` em vez de esperar.

3. *(Opcional, defensivo)* em `finalizeDotReservation`, no ramo de 0 linhas:
   se o estado final não for `settled`, abortar a transação (rollback do
   `ai_usage`) e retornar `ok:false`, em vez de `ok:true, duplicate:true`.

Após aplicada, repetir: os 3 arquivos individuais, `npm run test:postgres` e as
5 repetições do teste #22.

---

## 8. Critérios de aprovação × evidência

| Critério | Evidência | Situação |
|---|---|---|
| Atomicidade reserva/finalização | #19, #20 | ✅ |
| Idempotência | #20 (duas instâncias → 1 consumo), #10, #11 | ✅ |
| Índice único parcial | #18 | ✅ |
| Isolamento entre tenants | #21 (EMPRESA/EMPRESA_B) | ✅ |
| `TIMESTAMPTZ` | #18, #19, #23 | ✅ |
| Reservas `sent` não expiradas | #18–#23 (guard `sent_at IS NULL` + carência) | ✅ |
| Falhas ambíguas sem liberação indevida | #23 | ✅ |
| Concorrência multi-processo | #4, #6, #10, #11, #14, #20, #21 | ✅ |
| **Ausência de consumo duplicado/órfão** | **#22** | ❌ **falha** |
| Limpeza dos bancos descartáveis | `dropTestDatabase` + `finally`; bancos temporários removidos | ✅ |

---

## 9. Logs preservados e hashes

Logs brutos (sem credenciais; usuário/banco de teste apenas) em
`review/pg17-logs/` e em `~/logs/` no WSL:

| Arquivo | SHA-256 |
|---|---|
| `dotLedger.log` | `3f84872ec7fbd691dea80f2978afe55218e53552467cbab85f472bc0d777988b` |
| `dotExecutionAtomicity.log` | `aed8222ea371f8ef09a23b88c4cabff01dd45b75c4eacd7f94d9af6712892be2` |
| `dotActionConcurrency.log` | `094d3b864694354960317ac7c221e1f6e94cc33cd99c20a5970572ec50fc8a34` |
| `test-postgres.log` | `ead0047e7a8bb64754fe892d9d89758eef223e72576338b57f537b3cc1cc9187` |
| `sweep-run-1.log` | `db2fc92863cb23a09dea7259e21737ea246f3445753a76f1e1303617a6f1b0ba` |
| `sweep-run-2.log` | `3a9a132d82f50bac0e065eb0ff481faf1bf255ecdeaa8ca468459af9fac92e4f` |
| `sweep-run-3.log` | `15a2a0ad06b46a4bc81803f36872f5e03a0307274e6deee8a1ac4ff19e7bf8b1` |
| `sweep-run-4.log` | `d3a8a24f59d3c19cf4adabf3d2d8b499a5fbabdfe0123c7e6ddeaf7af76e281d` |
| `sweep-run-5.log` | `b41953cbe23414a1b49328d7018cb80da93f4c101669199774e51314f41fc43c` |

Referências do código auditado:

- `services/dotLedger.ts` linhas 667–675 (UPDATE `expired`) e 677–691 (UPDATE `ambiguous`);
- `services/dotLedger.ts` ≈566 (ramo de 0 linhas do `finalize`);
- `tests/dotLedger.pg.test.ts` linha 166.

---

## 10. Limitações e riscos

- A suíte rodou em cópia `git archive` do HEAD no WSL, não no checkout Windows,
  porque o `localhostForwarding` do WSL2 estava indisponível. A cópia é idêntica
  ao HEAD (332 arquivos; hash de manifesto acima) e o repo original não foi tocado.
- `trust` restrito a loopback dentro do WSL descartável; não há exposição de rede.
- TimeZone do cluster é `America/Sao_Paulo`; instantes `TIMESTAMPTZ` não são
  afetados, mas comparações dependentes de fuso local não foram exercitadas.
- A falha #22 foi reproduzida com interleaving favorável ao `finalize`
  (probe 1/3 e 5/5 repetições no teste). Em ambientes mais lentos o `sweep` pode
  vencer a corrida e o teste passar por acaso — a falha é real, não flake.
- `dotAdminPin` (flake pré-existente, decisão D1) não faz parte da suíte PG.

---

## 11. Conclusão

**APROVADO** após a correção do commit `e8345a6` (seção 0). A falha original
(seções 1 e 6) foi reproduzida e eliminada: 35/35 testes PostgreSQL, teste #22
5/5, 431/431 SQLite, `tsc` limpo, sem consumo órfão nem duplicado.

A seção 6 permanece como registro histórico do defeito e a seção 7 como a
proposta que foi aplicada — os quatro lotes anteriores (`b69bf3b`, `6f63380`,
`70a106b`, `932a2d0`) não foram reescritos.
