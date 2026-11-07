# DSV4 — Implementação controlada do DOT Durable Token Ledger — Lote 2 (Groq e contabilização)

**HEAD-base:** `b69bf3baac6e4c5f751594329f822bae2e6e9d7e` · **Pai:** `a907a345bd38523b1b984364235686f3641a7700`
**Branch:** `reconcile/dot-production-2026-11-06` (inalterada)
**Escopo:** `lib/aiUsage.ts`, `groqService.ts` e testes de contabilização. **Sem** rotas, admin, scheduler, worker, server, retry/acquisition, CI ou `.env.example`.

## 1. Artefatos de revisão usados (SHA-256)

| Artefato | SHA-256 |
|---|---|
| `review/aiUsage.ledger.proposed.ts.txt` | `f20707a0d763955a668e0b1665f1451749b5ba3b11766334180c5210bb18fe40` |
| `review/groqService.ledger.proposed.ts.txt` | `20eae95ac790eb02478e6f00d8e193b2883d42eefd14c019955816c9db5ffb0a` |
| `review/ledger-cross-review.md` | `e138226a59fc265db2af96375b5547f2f289df7931f0e7f17723eb84a2fafdd0` |
| `review/ledger-dependency-matrix.md` | `3bda51421533dde1608dc7d41228dfaa289d33742a1ec9b2eb4537f29c789cd1` |
| `review/ledger-risk-register.md` | `c07405d368543f0bc0d5872944ee9089f7eb0dc4caf1f74e33bf13c143ac3ddb` |
| `review/ledger-implementation-sequence.md` | `5e989c6aa187767aacc09a89f0d4ebcad3b81f308a39e6e55d8b018cfb194275` |

## 2. Arquivos alterados

- `lib/aiUsage.ts` — `ensureAiUsageSchema` adiciona `tokens_input`/`tokens_output` (ALTER idempotente); `recordAiUsage` grava a quebra in/out com **`null` quando o provedor não informa** (desconhecido ≠ zero).
- `groqService.ts` — `callAIReal` + indireção `setCallAIImpl` (**restrito a `NODE_ENV === 'test'`**); `skipUsageRecord` honrado; captura `prompt_tokens`/`completion_tokens` (Groq) e `promptTokenCount`/`candidatesTokenCount` (Gemini); `AiCallResult.input_tokens`/`output_tokens`; `callAI` mantém a assinatura pública.
- `tests/aiUsageDedup.test.ts` (**novo**) — contabilização tradicional, `skipUsageRecord`, tokens in/out, dedup e `setCallAIImpl` (teste × fora).

## 3. Contratos preservados

- `callAI(system, user, maxTokens?, temperature?, opts?)` — assinatura inalterada (apenas `opts.skipUsageRecord?` opcional). Consumidores não-DOT (lead, relatórios, sentimento, tags) seguem contabilizando pela via normal.
- `AiCallResult` ganha 2 campos **novos** (retorno), sem quebrar destructuring existente.
- `ensureAiUsageSchema`/`recordAiUsage` permanecem com as mesmas chamadas; campos novos opcionais.
- Nenhum hook de teste em produção: `setCallAIImpl` lança fora de `NODE_ENV === 'test'`.
- **Sem alteração de rotas** neste lote.

## 4. Testes executados — resultados REAIS

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit` | **EXIT 0** |
| `node --import tsx --test --test-concurrency=1 tests/aiUsageDedup.test.ts tests/aiFailover.test.ts tests/aiLoadBalance.test.ts tests/dotProviderOutcome.test.ts` | **17/17 PASS**, EXIT 0 |
| `node --import tsx --test tests/dotModelRouting.test.ts` (consumidor de `groqService`) | **4/4 PASS**, EXIT 0 |

Cobertura comprovada:
- **Contabilização tradicional**: 1 linha em `ai_usage` com `tokens=18`, `tokens_input=11`, `tokens_output=7` (fetch simulado).
- **`skipUsageRecord: true`**: **0 linhas** — o ledger é a fonte única.
- **Tokens in/out** retornados no `AiCallResult`.
- **`setCallAIImpl`**: usa o duplo em `NODE_ENV=test`; **lança** fora dele; `setCallAIImpl(null)` restaura.
- **Falhas do provedor** (408/429/5xx/timeout/4xx estruturado): `dotProviderOutcome` (10/10) — nenhuma falha ambígua libera orçamento.
- **Compatibilidade não-DOT**: `aiFailover`, `aiLoadBalance`, `dotModelRouting` verdes.

**PostgreSQL:** a validação PG do Lote 1 **permanece pendente** (sem ambiente). Nenhum teste PG foi executado nem declarado aprovado neste lote.

## 5. Diffstat

```
 groqService.ts             |  73 ++++++++++++++++++++----
 lib/aiUsage.ts             |  21 ++++++-
 tests/aiUsageDedup.test.ts | 139 +++++++++++++++++++++++++++++++++++++++++++++
 3 files changed, 221 insertions(+), 12 deletions(-)
```

## 6. Riscos e pendências

1. **PostgreSQL BLOCKED (herdado do Lote 1):** `dotLedger.pg.test.ts` e a concorrência multi-processo seguem **não executados**; a aprovação final para integração continua pendente de PG 17 descartável.
2. **Campos `input_tokens`/`output_tokens` = `null`** quando o provedor não informa — a soma usa `total_tokens` reportado ou estimativa; testes cobrem o caminho com valores informados.
3. **`setCallAIImpl`** só é usado por testes; os testes HTTP do DOT (Lote 3) o usarão sob `NODE_ENV=test`.
4. Fora do lote 2 (Lote 3+): rotas (`dotRoutes` v2, `dotAdminRoutes`), scheduler, worker, server, retry/acquisition/replenisher, CI, `.env.example`, correções PG de atomicidade/concorrência.
