/**
 * Helper para acoplar Stripe ao server.ts atual.
 *
 * No server.ts (mínimo):
 *
 * 1) import { mountStripeRoutes } from './stripeRoutes.js';
 * 2) Trocar app.use(express.json(...)) por skip no webhook (ver abaixo)
 * 3) Após await initDB(): mountStripeRoutes(app, () => db);
 *
 * Middleware JSON (substituir a linha express.json):
 *
 * app.use((req, res, next) => {
 *   if (req.originalUrl?.startsWith('/api/webhook/stripe')) return next();
 *   return express.json({ limit: '20kb' })(req, res, next);
 * });
 */
export { mountStripeRoutes } from './stripeRoutes.js';
export { stripeConfigured, listPlanosPublicos } from './stripeBilling.js';

