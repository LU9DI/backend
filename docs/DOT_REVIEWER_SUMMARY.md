# Filtra Dot — resumo para revisão independente (PRs #144 e #203)

> Este documento é um roteiro para o revisor humano. Ele **não** registra, simula
> ou substitui aprovação. Situação em 2026-11-11: **0 reviews** e **0 revisores
> solicitados** nas duas PRs; o único colaborador dos repositórios é `LU9DI`
> (a mesma identidade autenticada que publicou os commits), portanto **não há
> revisor independente disponível para solicitar**. O agente não aprovou e não
> deve aprovar as PRs em nome do responsável.

## 1. Escopo

| | Backend #144 | Frontend #203 |
|---|---|---|
| HEAD | `5fb46bd4` (código validado em `de722b5a`) | `c9510330` |
| Tema | ledger durável, idempotência HTTP, observabilidade e ativação do Dot | página `/dot/conversa` + E2E no CI |
| CI | `test` 484/484, `postgres-concurrency` 41/41, `audit` success | 13 checks success (inclui `e2e` com 26 aprovados) |
| Status externo | Deno Deploy falha por organização suspensa (não bloqueia tecnicamente) | — |

Documento completo: `docs/DSV4_MISSION2_REVIEW_PACKAGE.md`.
Riscos residuais: `docs/DOT_RESIDUAL_RISKS.md`.
Operação de alertas: `ops/alerts/README.md`.

## 2. O que revisar primeiro

1. **Contrato de idempotência** (`services/dotHttpIdempotency.ts`, rota
   `POST /api/dot/chat`): `processing → completed | ambiguous | failed_safe`;
   replay só com mesmo hash de payload; lease expirado vira ambíguo e nunca é
   retomado automaticamente; 409 com códigos distintos
   (`DOT_REQUEST_IN_PROGRESS`, `DOT_REQUEST_AMBIGUOUS`,
   `DOT_IDEMPOTENCY_KEY_REUSED`).
2. **Transições financeiras** (`services/dotLedger.ts`): reserva → `sent_at` →
   liquidação (insert em `ai_usage` na mesma transação) ou liberação só com
   prova de não envio; `FOR UPDATE` + lock por empresa; ambíguo mantém reserva;
   sweep não libera ambíguo.
3. **Multi-tenant**: reserva, claim e cache usam `empresa_id`; frontend escopa
   histórico/sessão/outbox por `empresa|usuário` (teste 3 do E2E).
4. **Autenticação/CSRF**: `X-Dot-Csrf` e `Authorization` validados antes da
   mutação; E2E confere os headers e o 401/expiração.
5. **Migrações**: `scripts/staging-migration-check.ts` (dry-run), digest de
   schema, aplicação dupla idempotente, backup/restore e falha injetada —
   evidência em `staging/logs/migration-check.log`.
6. **Observabilidade**: redação de conteúdo/credenciais, `request_id` em toda
   resposta, contadores e catálogo A1–A12 (alertas **não ativados**).

## 3. Perguntas que o revisor deve responder

1. O replay de uma chave `completed` devolve exatamente o corpo original, sem
   nova reserva/consumo? (Sim no código e no teste de idempotência.)
2. Um crash entre envio ao provedor e liquidação mantém a reserva ambígua e
   impede reenvio automático? (Sim; reconciliação é manual.)
3. Existe caminho em que `ai_usage` seja inserido duas vezes para a mesma
   reserva? (Testes PG cobrem concorrência; revisar `FOR UPDATE` e o retorno
   `settled`→`duplicate`.)
4. O failover de base do frontend reutiliza a mesma chave e o mesmo corpo?
   (Teste 8 do E2E.)
5. Algum log contém prompt, resposta, token ou chave de idempotência?
   (`lib/observability.ts` + `tests/observability.test.ts`.)

## 4. Como reproduzir a validação

```bash
# backend
cd backend && npm run build && npm test        # 484 testes locais no CI
DATABASE_URL=postgresql://...127.0.0.1:55432/filtra_staging \
  NODE_ENV=test LC_ALL=C npm run test:postgres # 41 testes
npx tsx scripts/staging-migration-check.ts     # dry-run em staging

# frontend
cd frontend/frontend && npx playwright test    # 27 testes (19 do Dot)
```

Evidências: `staging/logs/test-backend-full.log`, `test-postgres-final2.log`,
`e2e-dot-conversa-final.log`, `migration-check.log`, `alerts-tests2.log`.

## 5. Critérios de aceite sugeridos

- [ ] Contrato de idempotência e transições do ledger revisados linha a linha.
- [ ] Nenhum caminho de cobrança dupla identificado (incluindo retry/crash).
- [ ] Redação de logs e ausência de segredos confirmadas.
- [ ] Migração revisada e compatível com o schema de produção (exige leitura do
      Supabase — pendente de acesso).
- [ ] Riscos residuais aceitos formalmente ou corrigidos antes da produção.
- [ ] Aprovação registrada por revisor humano distinto do autor.

## 6. Limites desta preparação

- Nenhuma revisão foi solicitada porque não há identidade independente
  autorizada disponível; o agente não aprova PRs.
- CI verde não substitui revisão humana.
- O preview do Vercel da PR é automático e não é deploy de produção.
