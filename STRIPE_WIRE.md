# Ligar Stripe no server.ts atual (3 edições mínimas)

Não reescreve trial, IA, PDF nem login — só encaixa checkout.

## 1. Import (junto dos outros imports)

```ts
import { mountStripeRoutes } from './stripeRoutes.js';
import { stripeConfigured } from './stripeBilling.js';
```

## 2. Body parser (substituir a linha `app.use(express.json...)`)

Para o webhook do Stripe funcionar, o JSON global **não** pode consumir `/api/webhook/stripe`:

```ts
app.use(cookieParser());
app.use((req, res, next) => {
  if (req.originalUrl?.startsWith('/api/webhook/stripe')) return next();
  return express.json({ limit: '20kb' })(req, res, next);
});
```

(Remova o `app.use(express.json({ limit: '20kb' }));` antigo se ainda estiver acima.)

## 3. Depois de `await initDB()` no `main()`

```ts
await initDB();
mountStripeRoutes(app, () => db);
console.log(`💳 Stripe: ${stripeConfigured() ? 'ok' : 'off'}`);
app.listen(PORT, () => console.log(`🚀 Servidor em http://localhost:${PORT}`));
```

## Env

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...   # em produção
APP_URL=http://localhost:3000
FRONTEND_URL=http://localhost:3000
```

Webhook no Dashboard Stripe: `https://SUA_API/api/webhook/stripe`  
Eventos: `checkout.session.completed`, `customer.subscription.*`, `invoice.paid`

## Fluxo UI

Home → cards de plano → `POST /api/checkout` → `checkout_url` → tela de cartão Stripe.
