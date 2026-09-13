/**
 * Alternar plano no painel para testes (sem Stripe).
 * Ativo quando NODE_ENV !== production OU ALLOW_PLAN_SWITCH=1
 * Desliga com ALLOW_PLAN_SWITCH=0
 */
import type { Express, Response } from 'express';
import type { AuthRequest } from '../lib/auth.js';
import { getDb, findEmpresa } from '../lib/db.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { PLANOS_OFICIAIS, isPlanoOficial, allowPlanSwitch, planLabel } from '../lib/plans.js';
import { planTemIA } from '../lib/quota.js';
import { autenticarToken, isAdminUser } from '../lib/auth.js';

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
        relatorio_whatsapp: planTemIA(p),
        pdf: false,
      })),
    });
  });

  app.patch(
    '/api/empresa/:ref/plano',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!allowPlanSwitch()) {
        return res.status(403).json({
          error: 'Troca de plano por teste desativada em produção. Defina ALLOW_PLAN_SWITCH=1 no .env para liberar.',
        });
      }

      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerirEmpresa(req, empresa.id)) return res.status(403).json({ error: 'Sem permissão para alterar o plano desta empresa.' });

      const raw = String(req.body.plan || req.body.plano || '').toLowerCase().trim();
      if (!isPlanoOficial(raw)) {
        return res.status(400).json({ error: `Plano inválido. Use um de: ${PLANOS_OFICIAIS.join(', ')}`, planos: PLANOS_OFICIAIS });
      }

      const expira = new Date();
      expira.setDate(expira.getDate() + 30);
      await getDb().run(
        `UPDATE empresas SET plan = ?, status = 'ativo', expira_em = ?, cancel_at_period_end = 0 WHERE id = ?`,
        [raw, expira.toISOString(), empresa.id]
      );

      res.json({
        success: true,
        plan: raw,
        label: planLabel(raw),
        status: 'ativo',
        expira_em: expira.toISOString(),
        relatorio_whatsapp_disponivel: planTemIA(raw),
        pdf_disponivel: false,
        modo_teste: true,
        mensagem: `Plano alterado para ${planLabel(raw)} (modo teste — sem cobrança Stripe).`,
      });
    })
  );
}
