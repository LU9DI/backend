# O que ainda dá para fazer sem reescrever o código de hoje

## Já feito (arquivos isolados)
- Checkout Stripe + webhook com cancelamento até o fim do ciclo
- Cards de plano no frontend + texto formal de cancelamento
- Portal do cliente (módulo) — ver `criarPortalSession` em `stripeBilling.ts`
- `.env.example`

## Pendente com 3 linhas no `server.ts` (não reescreve o resto)
Ver `STRIPE_WIRE.md`:
1. import de `mountStripeRoutes`
2. body parser que pula o webhook
3. `mountStripeRoutes(app, () => db)` após `initDB`

Sem isso, `/api/checkout` e o webhook **não sobem**.

## Seguro depois (quando autorizar)
| Item | Interfere no core? |
|------|--------------------|
| Ligar o wire do Stripe no `server.ts` | Só 3 trechos mínimos |
| Botão "Gerenciar assinatura" no painel (portal Stripe) | Só frontend + rota já preparada |
| Usar `empresaTemAcesso()` nas rotas de avaliação/painel | 1 if por rota |
| Página `/login` separada (Task 7 do Spec Kit) | Frontend novo |
| Testes manuais Stripe (test mode) | Zero código |

## Evitar por agora
- Reescrever motor de IA / PDF / trial
- Trocar o modelo de login de funcionários
- Migrar banco no meio do fluxo atual
