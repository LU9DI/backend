import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb, findEmpresa } from '../lib/db.js';
import { normalizarWhatsapp, linkWhatsapp } from '../lib/whatsapp.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  planTemPdf,
  allowPlanSwitch,
  PLANOS_OFICIAIS,
  planLabel,
  isTrialPlan,
  isPlanoOficial,
} from '../lib/plans.js';
import { autenticarToken, type AuthRequest } from '../lib/auth.js';
import { podeGerirEmpresa } from './empresaRoutesHelpers.js';

const whatsappPatchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas alterações de WhatsApp. Aguarde.' },
});

const planPatchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: { error: 'Muitas trocas de plano. Aguarde.' },
});

export function mountEmpresaPatchRoutes(app: Express) {
  app.get(
    '/api/empresa/:ref/validar',
    asyncHandler(async (req: Request, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ valido: false, motivo: 'not_found' });
      const agora = new Date();
      const expira = new Date(empresa.expira_em);
      if ((empresa.status === 'trial' || empresa.status === 'teste') && agora > expira) {
        return res.json({
          valido: false,
          motivo: 'expired',
          nome: empresa.nome_empresa,
          empresa_id: empresa.id,
          slug: empresa.slug,
        });
      }
      if (empresa.status === 'bloqueado') {
        return res.json({ valido: false, motivo: 'inactive', nome: empresa.nome_empresa });
      }
      const wpp = normalizarWhatsapp(empresa.whatsapp_suporte);
      return res.json({
        valido: true,
        nome: empresa.nome_empresa,
        empresa_id: empresa.id,
        slug: empresa.slug,
        google_review_url: empresa.google_review_url || null,
        whatsapp: wpp,
        whatsapp_url: linkWhatsapp(wpp),
        plan: empresa.plan,
      });
    })
  );

  app.patch(
    '/api/empresa/:ref/plano',
    planPatchLimiter,
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      if (!allowPlanSwitch()) {
        return res.status(403).json({
          error:
            'Troca de plano de teste desativada em produção. Use Stripe/checkout ou defina ALLOW_PLAN_SWITCH=1.',
          code: 'PLAN_SWITCH_DISABLED',
        });
      }
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerirEmpresa(req, empresa.id)) {
        return res.status(403).json({ error: 'Sem permissão.' });
      }
      const plan = String(req.body.plan || req.body.plano || '').toLowerCase().trim();
      if (!isPlanoOficial(plan) && !isTrialPlan(plan)) {
        return res.status(400).json({
          error: `Plano inválido. Use: ${[...PLANOS_OFICIAIS, 'trial'].join(', ')}`,
        });
      }
      const dias = isTrialPlan(plan) ? 7 : 30;
      const expira = new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toISOString();
      const status = isTrialPlan(plan) ? 'trial' : 'ativo';
      await getDb().run(
        `UPDATE empresas SET plan = ?, status = ?, expira_em = ?, cancel_at_period_end = 0 WHERE id = ?`,
        [plan, status, expira, empresa.id]
      );
      res.json({
        success: true,
        plan,
        status,
        expira_em: expira,
        mensagem: `Plano ${planLabel(plan)} ativo (modo teste — sem cobrança).`,
        pdf_disponivel: planTemPdf(plan),
      });
    })
  );

  app.patch(
    '/api/empresa/:ref/whatsapp',
    whatsappPatchLimiter,
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerirEmpresa(req, empresa.id)) {
        return res.status(403).json({ error: 'Sem permissão.' });
      }
      const raw = String(req.body.whatsapp || req.body.whatsapp_suporte || '').trim();
      if (!raw) {
        await getDb().run(`UPDATE empresas SET whatsapp_suporte = NULL WHERE id = ?`, [empresa.id]);
        return res.json({ success: true, whatsapp: null, whatsapp_url: null });
      }
      const normalizado = normalizarWhatsapp(raw);
      if (!normalizado) {
        return res.status(400).json({ error: 'WhatsApp inválido. Use DDD + número.' });
      }
      await getDb().run(`UPDATE empresas SET whatsapp_suporte = ? WHERE id = ?`, [
        normalizado,
        empresa.id,
      ]);
      res.json({
        success: true,
        whatsapp: normalizado,
        whatsapp_url: linkWhatsapp(normalizado),
      });
    })
  );

  app.patch(
    '/api/empresa/:ref/google',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerirEmpresa(req, empresa.id)) {
        return res.status(403).json({ error: 'Sem permissão.' });
      }
      let url = String(req.body.google_review_url || req.body.url || '').trim();
      if (!url) {
        await getDb().run(`UPDATE empresas SET google_review_url = NULL WHERE id = ?`, [empresa.id]);
        return res.json({ success: true, google_review_url: null });
      }
      if (!/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: 'URL inválida. Use http:// ou https://' });
      }
      if (url.length > 500) return res.status(400).json({ error: 'URL muito longa (máx. 500).' });
      await getDb().run(`UPDATE empresas SET google_review_url = ? WHERE id = ?`, [url, empresa.id]);
      res.json({ success: true, google_review_url: url });
    })
  );
}
