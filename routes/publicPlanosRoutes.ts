/**
 * GET /api/planos — preços públicos.
 * Pagamentos: Mercado Pago + PayPal.
 */
import type { Express, Request, Response } from 'express';
import { getDb } from '../lib/db.js';
import { listPlanPrices, ensurePlanPricingSchema } from '../lib/planPricing.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { refreshPlanPricesFromDb } from '../stripeBilling.js';
import { paypalConfigured } from '../lib/paypal.js';
import { mpConfigured, mpTokenMode } from '../lib/mercadopago.js';

const LABELS: Record<string, string> = {
  inicial: 'Inicial',
  pro: 'Pro',
  ultra: 'Ultra',
  corporativo: 'Corporativo',
  rei: 'REI',
};

const OFFICIAL_LIMITS: Record<string, number> = {
  inicial: 100,
  pro: 300,
  ultra: 800,
  corporativo: 2500,
  rei: 8000,
};

const FEATURES: Record<
  string,
  { features: string[]; missingFeatures?: string[]; highlight?: boolean }
> = {
  inicial: {
    features: ['100 feedbacks/mês', 'WPP Integrado', 'Gráficos básicos'],
    missingFeatures: ['Integrado com IA'],
  },
  pro: {
    features: ['300 feedbacks/mês', 'WPP Integrado', 'Gráficos básicos', '1 Relatório PDF/mês'],
    missingFeatures: ['Integrado com IA'],
  },
  ultra: {
    features: [
      '800 feedbacks/mês',
      'WPP Integrado',
      'IA Ativa',
      '1 Relatório PDF/mês',
      'Dashboard com análises',
    ],
    highlight: true,
  },
  corporativo: {
    features: [
      '2.500 feedbacks/mês',
      'WPP Integrado',
      'IA Ativa',
      '1 Relatório PDF/mês',
      'Dashboard Multi-unidades',
      'Suporte Prioritário',
      'Acesso antecipado a novas funções',
    ],
  },
  rei: {
    features: [
      '8.000 feedbacks/mês',
      'WPP Integrado',
      'IA Ativa',
      '1 Relatório PDF/mês',
      'Dashboard Multi-unidades',
      'Suporte Prioritário',
      'Acesso antecipado a novas funções',
    ],
  },
};

function fmtBrl(n: number): string {
  const num = Number(n).toFixed(2).replace('.', ',');
  return `R$\u00a0${num}`;
}

export function mountPublicPlanosRoutes(app: Express) {
  app.get(
    '/api/planos',
    asyncHandler(async (_req: Request, res: Response) => {
      const db = getDb();
      await ensurePlanPricingSchema(db);
      try {
        await refreshPlanPricesFromDb(db);
      } catch {
        /* */
      }

      const { planos, annual_discount_pct } = await listPlanPrices(db);

      const cards = planos.map((p: any) => {
        const plan = String(p.plan);
        const limit = OFFICIAL_LIMITS[plan] ?? Number(p.review_limit) || 0;
        const feat = FEATURES[plan] || { features: [] };
        const features = (feat.features || []).map((f) =>
          /feedbacks\/mês/i.test(f)
            ? `${limit.toLocaleString('pt-BR')} feedbacks/mês`
            : f
        );

        return {
          plan,
          keyMensal: plan,
          keyAnual: `${plan}-anual`,
          label: LABELS[plan] || plan,
          month_brl: Number(p.month_brl),
          year_monthly_brl: Number(p.year_monthly_brl),
          annual_total_brl: Number(p.annual_total_brl),
          review_limit: limit,
          priceMensal: fmtBrl(Number(p.month_brl)),
          priceAnual: fmtBrl(Number(p.year_monthly_brl)),
          features,
          missingFeatures: feat.missingFeatures || [],
          highlight: Boolean(feat.highlight),
          pagamento: ['mercadopago', 'paypal'],
        };
      });

      const order = ['inicial', 'pro', 'ultra', 'corporativo', 'rei'];
      cards.sort((a, b) => order.indexOf(a.plan) - order.indexOf(b.plan));

      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.json({
        planos: cards,
        annual_discount_pct,
        pagamentos: {
          stripe: false,
          paypal: paypalConfigured(),
          mercadopago: mpConfigured(),
          pix_token_mode: mpConfigured() ? mpTokenMode() : null,
        },
        updated_at: new Date().toISOString(),
      });
    })
  );
}
