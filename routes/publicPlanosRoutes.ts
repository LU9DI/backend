/**
 * Preços públicos dos planos (mesmos valores editados no admin).
 * GET /api/planos — sem auth, para a landing em localhost:3000.
 */
import type { Express, Request, Response } from 'express';
import { getDb } from '../lib/db.js';
import { listPlanPrices, ensurePlanPricingSchema } from '../lib/planPricing.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { PLANOS, listPlanosPublicos, refreshPlanPricesFromDb } from '../stripeBilling.js';

const LABELS: Record<string, string> = {
  inicial: 'Inicial',
  pro: 'Pro',
  ultra: 'Ultra',
  corporativo: 'Corporativo',
  rei: 'REI',
};

const FEATURES: Record<
  string,
  { features: string[]; missingFeatures?: string[]; highlight?: boolean }
> = {
  inicial: {
    features: ['150 feedbacks/mês', 'WPP Integrado', 'Gráficos básicos'],
    missingFeatures: ['Integrado com IA'],
  },
  pro: {
    features: ['400 feedbacks/mês', 'WPP Integrado', 'Gráficos básicos', '1 Relatório PDF/mês'],
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
  return `R$ ${Number(n).toFixed(2).replace('.', ',')}`;
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
        const limit = Number(p.review_limit) || 0;
        const feat = FEATURES[plan] || { features: [] };
        // Atualiza texto de feedbacks se o limite mudou no admin
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
        };
      });

      // ordem comercial
      const order = ['inicial', 'pro', 'ultra', 'corporativo', 'rei'];
      cards.sort((a, b) => order.indexOf(a.plan) - order.indexOf(b.plan));

      res.setHeader('Cache-Control', 'public, max-age=30');
      res.json({
        planos: cards,
        annual_discount_pct,
        stripe_planos: listPlanosPublicos(),
        updated_at: new Date().toISOString(),
      });
    })
  );
}
