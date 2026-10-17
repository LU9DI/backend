/**
 * Alternar plano no painel para testes (sem Stripe).
 * Produção: sempre desativado (use checkout ou ação administrativa).
 * Fora de produção: ativo por padrão; ALLOW_PLAN_SWITCH=0/false desliga.
 */
import type { Express, Response } from 'express';
import { getDb, findEmpresa } from '../lib/db.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  PLANOS_OFICIAIS,
  isPlanoOficial,
  allowPlanSwitch,
  planTemRelatorio,
  planLabel,
} from '../lib/plans.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';

function podeGerirEmpresa(req: AuthRequest, empresaId: string): boolean {
  if (isAdminUser(req.user)) return true;
  return Boolean(req.user?.empresa_id && req.user.empresa_id === empresaId);
}

export function mountPlanSwitchRoutes(app: Express) {
  app.get('/api/planos-teste', (_req, res) => {
    res.json({
      enabled: allowPlanSwitch(),
      planos: PLANOS_OFICIAIS.map((p) => ({
        key: p,
        label: planLabel(p),
        relatorio: planTemRelatorio(p),
      })),
    });
  });

  app.patch(
    '/api/empresa/:ref/plano',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!allowPlanSwitch()) {
        return res.status(403).json({
          error:
            'Troca de plano por teste desativada em produção. Use o checkout (Stripe/Mercado Pago/PayPal) ou uma ação administrativa.',
        });
      }

      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });

      if (!podeGerirEmpresa(req, empresa.id)) {
        return res.status(403).json({ error: 'Sem permissão para alterar o plano desta empresa.' });
      }

      const raw = String(req.body.plan || req.body.plano || '').toLowerCase().trim();
      if (!isPlanoOficial(raw)) {
        return res.status(400).json({
          error: `Plano inválido. Use um de: ${PLANOS_OFICIAIS.join(', ')}`,
          planos: PLANOS_OFICIAIS,
        });
      }

      const expira = new Date();
      expira.setDate(expira.getDate() + 30);

      await getDb().run(
        `UPDATE empresas
         SET plan = ?, status = 'ativo', expira_em = ?, cancel_at_period_end = 0
         WHERE id = ?`,
        [raw, expira.toISOString(), empresa.id]
      );

      res.json({
        success: true,
        plan: raw,
        label: planLabel(raw),
        status: 'ativo',
        expira_em: expira.toISOString(),
        relatorio_disponivel: planTemRelatorio(raw),
        modo_teste: true,
        mensagem: `Plano alterado para ${planLabel(raw)} (modo teste — sem cobrança Stripe).`,
      });
    })
  );
}
