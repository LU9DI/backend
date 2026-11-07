# Filtra DOT — proposta: `.env.example`

**Modo:** somente leitura. `.env.example` **não** foi alterado. HEAD `a907a345bd38523b1b984364235686f3641a7700`.

- Tipo: **hunk**
- Diffstat: `1 file changed, 7 insertions(+)`
- Proposta: `review/env.example.ledger.proposed.txt`
- Diff: `review/env.example.ledger.proposed.diff`

## Contratos/exportações
- `FILTERA_PG_TEST_ALLOWED_HOSTS` (allowlist opt-in dos testes PG)
- `DOT_SENT_GRACE_MS` (carência antes de marcar reserva enviada como ambígua)

## Dependências
- nenhuma

## Testes associados
- n/a (documentação)

## Risco
- Apenas variáveis realmente usadas pelo código; defaults preservados.

> Relatório consolidado: `review/ledger-support-batch-proposal.md`.
