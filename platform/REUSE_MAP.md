# Filtra.AI → Multi-Product Reuse Map

A base atual do Filtra.AI já contém componentes que podem ser extraídos sem copiar regras de negócio.

## Reutilização prioritária

- lib/auth.ts — autenticação/JWT
- lib/jwtKeys.ts — rotação de chaves
- services/authService.ts — serviços de autenticação
- lib/db.ts / lib/db.pg.ts — persistência
- lib/env.ts — configuração e validação
- lib/cors.ts — CORS
- middleware/security.ts — headers/request id
- lib/metrics.ts — métricas
- lib/rateLimitHits.ts — rate limiting
- lib/auditLog.ts — auditoria
- lib/aiUsage.ts — controle de uso de IA
- groqService.ts — gateway/failover de IA existente
- lib/mailer.ts — e-mail
- lib/notifications.ts / lib/push.ts — notificações
- lib/retryQueue.ts / lib/retryHandlers.ts — processamento assíncrono
- stripeBilling.ts / lib/planPricing.ts / lib/planUtils.ts — billing/planos
- stripeRoutes.ts / routes/subscriptionRoutes.ts — padrões de assinatura
- relatorioPdf*.ts / lib/reportPdfStore.ts — geração/armazenamento de PDF, quando aplicável

## Reutilização condicionada

- lib/n8n.ts e routes/n8nRoutes.ts — automação via n8n
- lib/mercadopago.ts / routes/pixRoutes.ts — pagamentos Brasil
- lib/paypal.ts — pagamentos internacionais
- webauthn/mfa — autenticação reforçada

## Não compartilhar como domínio

- routes/empresaRoutes.ts
- routes/reviewRoutes.ts
- routes/fiscalRoutes.ts e lib/fiscal.ts (exceto dentro da Tax Platform)
- serviços específicos de reputação/reviews
- schemas e tabelas específicos do Filtra.AI

## Princípio

Primeiro extrair interfaces/adapters. Depois mover implementação compartilhada. Só então conectar cada produto ao core. O Filtra.AI não deve depender dos novos produtos.
