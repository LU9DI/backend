# Filtra DOT — proposta: `.github/workflows/ci.yml`

**Modo:** somente leitura. `.github/workflows/ci.yml` **não** foi alterado. HEAD `a907a345bd38523b1b984364235686f3641a7700`.

- Tipo: **hunk**
- Diffstat: `1 file changed, 14 insertions(+), 1 deletion(-)`
- Proposta: `review/ci.ledger.proposed.yml.txt`
- Diff: `review/ci.ledger.proposed.diff`

## Contratos/exportações
- `image: postgres:17`
- `POSTGRES_INITDB_ARGS="--encoding=UTF8 --locale=C"`
- `LC_ALL: C` / `LANG: C`
- step 'Guard — DATABASE_URL must be local'
- preserva `'chore/**'` no gatilho de push

## Dependências
- nenhuma

## Testes associados
- CI `postgres-concurrency` (23 testes PG + `dotLedger.pg.test`)

## Risco
- Sem segredos; DATABASE_URL local fixo no job.

> Relatório consolidado: `review/ledger-support-batch-proposal.md`.
