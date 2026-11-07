# Filtra DOT — proposta: `tests/helpers/pg-test-utils.ts`

**Modo:** somente leitura. `tests/helpers/pg-test-utils.ts` **não** foi alterado. HEAD `a907a345bd38523b1b984364235686f3641a7700`.

- Tipo: **hunk**
- Diffstat: `1 file changed, 39 insertions(+)`
- Proposta: `review/pg-test-utils.ledger.proposed.ts.txt`
- Diff: `review/pg-test-utils.ledger.proposed.diff`

## Contratos/exportações
- `LOCAL_TEST_HOSTS = {localhost,127.0.0.1,::1}`
- `assertSafeTestDatabaseUrl(url)` (localhost-only + `FILTERA_PG_TEST_ALLOWED_HOSTS`)
- uso em `databaseUrl()` (falha ANTES de conectar)

## Dependências
- preserva `runNodeScript`/`parseWorkerJson` (do HEAD)

## Testes associados
- `pgTestUtilsSafety.test`
- `dotLedger.pg.test`
- `dotExecutionAtomicity.pg.test`

## Risco
- Bloqueia banco remoto/produção; sem impacto nos helpers existentes.

> Relatório consolidado: `review/ledger-support-batch-proposal.md`.
