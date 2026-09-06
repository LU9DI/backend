/**
 * Cancelamento self-service e portal de cobrança.
 */
import type { Express, Response } from 'express';
import { getDb, findEmpresa } from '../lib/db.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { markCancelAtPeriodEnd } from '../services/billingService.js';
import { stripeConfigured, criarPortalSession } from '../stripeBilling.js';
import { mpConfigured } from '../lib/mercadopago.js';

function podeGerir(req: AuthRequest, empresaId: string): boolean {
  if (isAdminUser(req.user)) return true;
  return Boolean(req.user?.empresa_id && req.user.empresa_id === empresaId);
}

export function mountSubscriptionRoutes(app: Express) {
  /** Portal Stripe (cartão / fatura / cancelar no Stripe). */
  app.post(
    '/api/empresa/:ref/billing-portal',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const emp = await findEmpresa(String(req.params.ref));
      if (!emp) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerir(req, emp.id)) return res.status(403).json({ error: 'Sem permissão.' });

      if (!stripeConfigured() || !emp.stripe_customer_id) {
        return res.status(400).json({
          error:
            'Portal Stripe indisponível. Use cancelamento local ou complete um checkout com cartão.',
          code: 'NO_STRIPE_CUSTOMER',
        });
      }

      const portal = await criarPortalSession(String(emp.stripe_customer_id));
      res.json({ success: true, url: portal.url, provider: 'stripe' });
    })
  );

  /**
   * Cancela ao fim do período já pago (Stripe local flag + Pix/MP).
   * Não bloqueia imediatamente.
   */
  app.post(
    '/api/empresa/:ref/cancelar-assinatura',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const emp = await findEmpresa(String(req.params.ref));
      if (!emp) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerir(req, emp.id)) return res.status(403).json({ error: 'Sem permissão.' });

      if (emp.status !== 'ativo' && emp.status !== 'trial') {
        return res.status(400).json({ error: 'Não há assinatura ativa para cancelar.' });
      }

      if (Number(emp.cancel_at_period_end) === 1) {
        return res.json({
          success: true,
          already: true,
          mensagem: `Cancelamento já agendado. Acesso até ${emp.expira_em || 'fim do período'}.`,
          expira_em: emp.expira_em,
        });
      }

      const db = getDb();
      await markCancelAtPeriodEnd(db, emp.id, emp.expira_em || null);

      // Stripe: cliente pode ir ao portal para cancelar na Stripe também
      let portal_url: string | null = null;
      if (stripeConfigured() && emp.stripe_customer_id) {
        try {
          const portal = await criarPortalSession(String(emp.stripe_customer_id));
          portal_url = portal.url;
        } catch {
          /* */
        }
      }

      res.json({
        success: true,
        cancel_at_period_end: true,
        expira_em: emp.expira_em,
        provider: emp.payment_gateway || (emp.stripe_customer_id ? 'stripe' : mpConfigured() ? 'pix' : null),
        portal_url,
        mensagem: emp.expira_em
          ? `Cancelamento agendado. Você continua com acesso até ${emp.expira_em}. Sem cobrança no próximo ciclo.`
          : 'Cancelamento agendado. Acesso permanece até o fim do período já pago.',
      });
    })
  );

  /** Desfaz pedido de cancelamento (antes do fim do período). */
  app.post(
    '/api/empresa/:ref/reativar-assinatura',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const emp = await findEmpresa(String(req.params.ref));
      if (!emp) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerir(req, emp.id)) return res.status(403).json({ error: 'Sem permissão.' });

      if (emp.status !== 'ativo') {
        return res.status(400).json({
          error: 'Só é possível reativar se o status ainda for ativo (antes do bloqueio).',
        });
      }

      await getDb().run(`UPDATE empresas SET cancel_at_period_end = 0 WHERE id = ?`, [emp.id]);
      res.json({
        success: true,
        cancel_at_period_end: false,
        mensagem: 'Pedido de cancelamento removido. A assinatura segue normal.',
      });
    })
  );
}
