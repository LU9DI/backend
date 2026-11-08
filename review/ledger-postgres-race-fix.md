# Correção da corrida PostgreSQL `sweep` × `finalize` — Durable Token Ledger

Data: 2026-11-08
Repositório: `C:\Users\lucas\backend-pr139-integration`
Branch: `reconcile/dot-production-2026-11-06`
Commit da correção: **`e8345a6b73689b369fe2f640a246a59819b02f68`**
Pai (base obrigatória preservada): `932a2d0bedfd21fb63c59779eda0451dd35165fd`
Lotes anteriores intactos: `b69bf3b`, `6f63380`, `70a106b`, `932a2d0` (sem amend/rewrite).

---

## 1. Causa-raiz

`services/dotLedger.ts` → `sweepExpiredDotReservations`. Os dois `UPDATE` de
varredura filtravam apenas `id IN (subquery)`; os predicados de estado estavam
**somente dentro da subquery**.

Em PostgreSQL READ COMMITTED, quando o `UPDATE` externo encontra uma linha
travada por `finalizeDotReservation` (`SELECT … FOR UPDATE`), ele espera o
commit e **reavalia apenas o WHERE externo** — `id IN (...)`, que continua
verdadeiro. Resultado: a linha já gravada como `settled` era sobrescrita para
`expired`, mantendo `tokens_real` e `ai_usage_id`. O consumo ficava órfão e o
`finalize` retornava `ok:true`.

Evidência original (probe, 3 iterações): `{"finalize_ok": true,
"status_final": "expired", "ai_usage_rows": 1}`. Reprodução do teste #22: 5/5
falhas. Registro completo em `review/ledger-postgres17-validation.md` (seções 1
e 6).

---

## 2. SQL anterior → corrigido

### 2.1 Primeiro UPDATE (expirar `pending` sem envio)

Antes (`services/dotLedger.ts`, ~667–675):

```sql
UPDATE dot_budget_reservations
   SET status = 'expired', updated_at = ?
 WHERE id IN (
   SELECT id FROM dot_budget_reservations
    WHERE status = 'pending' AND ambiguous = 0 AND expires_at <= ? AND sent_at IS NULL{scope}
    ORDER BY id ASC LIMIT {max}
 )
-- params: [now, now, ...scopeParams]
```

Depois:

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

### 2.2 Segundo UPDATE (marcar `sent` como ambígua)

Antes (~677–691):

```sql
UPDATE dot_budget_reservations
   SET ambiguous = 1, ambiguous_reason = ?, updated_at = ?
 WHERE id IN (
   SELECT id FROM dot_budget_reservations
    WHERE status = 'pending' AND ambiguous = 0 AND sent_at IS NOT NULL
      AND expires_at <= ? AND sent_at <= ?{scope}
    ORDER BY id ASC LIMIT {max}
 )
-- params: [reason, now, now, graceCutoff, ...scopeParams]
```

Depois:

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

`{scope}` = ` AND empresa_id = ?` quando `empresaId` é informado (isolamento por
tenant preservado). Reservas `sent_at IS NOT NULL` **continuam não sendo
expiradas** (C).

### 2.3 `finalizeDotReservation` — ramo de 0 linhas

Antes:

```ts
if (!updatedRow || updatedRow.changes !== 1) {
  const final = await tx.get('SELECT ... WHERE id = ? AND empresa_id = ?', [id, empresaId]);
  return { ok: true, reservation: final as DotReservation, duplicate: true };
}
```

Depois:

```ts
if (!updatedRow || updatedRow.changes !== 1) {
  const final = await tx.get('SELECT ... WHERE id = ? AND empresa_id = ?', [id, empresaId]);
  if (final && String(final.status) === 'settled') {
    return { ok: true, reservation: final as DotReservation, duplicate: true };
  }
  throw new Error(`reserva em estado '${final ? String(final.status) : 'inexistente'}' — liquidação não aplicada`);
}
```

O `throw` desfaz a transação (ROLLBACK do `ai_usage` já inserido) e o `catch`
existente devolve `{ ok: false }`. `duplicate` só é retornado quando o estado
persistido **confirmado** é `settled` (B). Nenhuma segunda linha de consumo é
criada.

---

## 3. Arquivos alterados e hashes

| Arquivo | SHA-256 |
|---|---|
| `services/dotLedger.ts` | `229d3eb684d128e98d1b4c58baa4cae065ba43d49ecae4036e1366c990819c32` |
| `tests/dotLedgerRace.pg.test.ts` (novo) | `0377e9d116306c6139544df8147168f1865d0da276ce9bafdcb5ccebe7374941` |

Commit: `e8345a6b73689b369fe2f640a246a59819b02f68`
Diff: `services/dotLedger.ts` +34/−15; `tests/dotLedgerRace.pg.test.ts` +205.

Nenhum outro arquivo de implementação foi tocado. `stash@{0}` preservado e não
aplicado.

---

## 4. Testes de regressão (`tests/dotLedgerRace.pg.test.ts`)

| # | Teste | Cobre |
|---|---|---|
| 1 | finalize vence e sweep posterior não altera `settled` | 1 |
| 2 | finalize × 2 sweeps concorrentes (8 iterações) | 1, 2, 3, 4 |
| 3 | sweep vence e finalize não declara sucesso falso | 2, 3 |
| 4 | dois finalizes concorrentes gravam um único consumo | 4 |
| 5 | repetir finalize liquidado é idempotente | 5 |
| 6 | outro tenant não afeta a reserva | 6 |
| 7 | `sent_at` não é expirado; vira ambígua após carência | 7 |

O teste 2 (loop) é o que trava a regressão do defeito: se o sweep sobrescrever
uma linha liquidada, o estado final vira `expired` com `finalize.ok === true` e
`ai_usage = 1`, falhando as asserções do ramo `else`.

---

## 5. Resultados reais (PostgreSQL 17.11 descartável, C/UTF8, 127.0.0.1:55433)

| Execução | Testes | Pass | Fail | Exit |
|---|---:|---:|---:|---:|
| `dotLedger.pg.test.ts` | 6 | 6 | 0 | 0 |
| `dotExecutionAtomicity.pg.test.ts` | 5 | 5 | 0 | 0 |
| `dotActionConcurrency.pg.test.ts` | 2 | 2 | 0 | 0 |
| `dotLedgerRace.pg.test.ts` | 7 | 7 | 0 | 0 |
| `npm run test:postgres` (11 arquivos) | **35** | **35** | **0** | **0** |
| `npm test` (não-PG, SQLite) | **431** | **431** | **0** | **0** |
| `tsc --noEmit` (Windows e WSL) | — | — | 0 | 0 |

### 5.1 Teste #22 — cinco repetições independentes

```
sweep2-run 1: EXIT=0 | # pass 1 | # fail 0
sweep2-run 2: EXIT=0 | # pass 1 | # fail 0
sweep2-run 3: EXIT=0 | # pass 1 | # fail 0
sweep2-run 4: EXIT=0 | # pass 1 | # fail 0
sweep2-run 5: EXIT=0 | # pass 1 | # fail 0
```

Antes da correção: 5/5 falhas. Depois: 5/5 aprovações.

### 5.2 Ausência de consumo órfão / duplicado

Coberta por asserções diretas no teste 2 do novo arquivo (8 iterações
concorrentes) e nos testes 1/3/4/5:

- `settled` ⇒ `finalize.ok === true`, `ai_usage = 1`, `ai_usage_id` preenchido;
- `expired` ⇒ `finalize.ok === false`, `ai_usage = 0`, `ai_usage_id` nulo;
- dois finalizes ⇒ `ai_usage = 1`;
- repetição ⇒ `ai_usage = 1` e `tokens_real` inalterado.

---

## 6. Logs preservados

Originais (falha, mantidos intactos): `review/pg17-logs/dotLedger.log`
(`3f84872e…`), `dotExecutionAtomicity.log` (`aed8222e…`),
`dotActionConcurrency.log` (`094d3b86…`), `test-postgres.log` (`ead0047e…`),
`sweep-run-1..5.log`.

Pós-correção:

| Arquivo | SHA-256 |
|---|---|
| `dotLedger-fixed.log` | `7d8874d125ef2aa50ab0f71b1660503399743af33ca1c0edd3f183a413627d83` |
| `dotExecutionAtomicity-fixed.log` | `b61f37750f5c6adb9bffde0a1413d06c8be6a977ccb74a4080c902cf8f954380` |
| `dotActionConcurrency-fixed.log` | `89fb61be84b843789d5158f39a0cde8a88ddc61cadb205a78715c4bd809cded4` |
| `dotLedgerRace.log` | `1f8836857d9cec328624e544a48ba62c7505b81866546fa4139a285f029e67fb` |
| `test-postgres-fixed.log` | `a3805bb222be35ff3234c8d6a20c64fce99748e934d2ff720793338f7e2f08b7` |
| `sqlite-suite.log` | `856e18faaf07cdc2c754dd73a478a4c8f3c6115dbecd2929815a2777b51a20cb` |
| `sweep2-run-1.log` | `642fca568ae18d38cdce4b99f963f8ee780bfe55b74e0e100a32828abbb4d5a0` |
| `sweep2-run-2.log` | `b212e82057d90118aceb3bd97c3892844889585d50c9135e93cb4daff0c117c1` |
| `sweep2-run-3.log` | `aae9d3a23c75c81db2ca6be902ab63bea287222920cda9719929de8565e94b19` |
| `sweep2-run-4.log` | `40666052fd657a9c78b1721fe1f2c8cb59168c74c5ea92b6229ab52ec55b6a8d` |
| `sweep2-run-5.log` | `faa1b42d06fe6203be46053736b52bc049a7a0134348217f77259c99bbce03fb` |

Sem credenciais nos logs (usuário/banco de teste `filtra_test`/`filtra_ledger_test`,
trust restrito a loopback).

---

## 7. Limitações e riscos restantes

- A suíte não-PG foi executada no WSL (ext4, mesmo alvo do CI Ubuntu) porque o
  `%TEMP%` do Windows estava saturado (~4,5 mil arquivos), degradando a criação
  de bancos SQLite. O código testado é o mesmo (cópia idêntica do `HEAD` +
  arquivos da correção); 431/431.
- O `throw` defensivo no `finalize` só ocorre se o estado mudar entre o
  `SELECT … FOR UPDATE` e o `UPDATE` — após a correção do sweep esse caminho não
  é alcançável nos cenários testados; permanece como fail-closed.
- `dotAdminPin` (flake pré-existente, decisão D1) não faz parte da suíte PG.
- Cluster descartável em `~/pg17-disposable` (WSL2), porta 55433, somente
  loopback; sem conexão com produção/staging.

---

## 8. Conclusão

**APROVADO** para os critérios PostgreSQL: 0 consumo órfão, 0 duplicação,
0 transição `settled → expired`, idempotência preservada, isolamento por tenant,
`sent` não expirada, todas as suítes PG verdes e `tsc` limpo.

Sem push da implementação, sem PR, sem merge, sem deploy.
