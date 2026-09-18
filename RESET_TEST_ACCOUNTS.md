# Reset de contas de teste

Remove empresas com `plan` ou `status` em `trial` / `teste` / `test`, junto com reviews, usuários da empresa e uso de IA. **Não remove o admin.**

## Opção 1 — API (após deploy)

1. Login admin e pegue o token/cookie
2. Pré-visualizar:

```bash
curl -s "$API/api/admin/empresas/reset-testes/preview" \
  -H "Authorization: Bearer SEU_TOKEN_ADMIN"
```

3. Executar:

```bash
curl -X POST "$API/api/admin/empresas/reset-testes" \
  -H "Authorization: Bearer SEU_TOKEN_ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"confirm":"RESET_TESTES"}'
```

## Opção 2 — Script no servidor

```bash
cd backend
npx tsx scripts/resetTestAccounts.ts --dry-run   # só lista
CONFIRM_RESET=1 npx tsx scripts/resetTestAccounts.ts
```

## O que NÃO é apagado

- Usuário admin (`empresa_id = admin`)
- Empresas com plano pago (inicial, pro, ultra, corporativo, rei) e status ativo/cancelado, salvo se o plan ainda for trial
