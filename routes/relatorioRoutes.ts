/**
 * Relatório PDF mensal — autenticado, cache em disco, sem chamadas de IA.
 */
import type { Express, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb, findEmpresa } from '../lib/db.js';
import { gerarRelatorioMensalPDF, ensureUnidadesSchema } from '../relatorioPdf.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validateReportMonth } from '../lib/dateValidation.js';
import { isTrialPlan, planTemPdf } from '../lib/plans.js';
import { logPdfGeneration } from '../lib/opsLog.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { readPdfCache, writePdfCache } from '../lib/pdfCache.js';

const pdfLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitos downloads de PDF deste IP. Aguarde um pouco.' },
});

function podeAcessarEmpresa(req: AuthRequest, empresaId: string): boolean {
  if (isAdminUser(req.user)) return true;
  return Boolean(req.user?.empresa_id && req.user.empresa_id === empresaId);
}

function authModeOf(req: AuthRequest): string {
  if (isAdminUser(req.user)) return 'jwt_admin';
  if (req.user?.empresa_id) return 'jwt_cliente';
  return 'jwt';
}

export function mountRelatorioRoutes(app: Express) {
  app.get(
    '/api/empresa/:ref/relatorio.pdf',
    pdfLimiter,
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const startedAt = Date.now();
      const authMode = authModeOf(req);
      const db = getDb();
      const empresa = await findEmpresa(req.params.ref);

      if (!empresa) {
        await logPdfGeneration(db, { status: 'error', error: 'Empresa não encontrada', auth_mode: authMode, duration_ms: Date.now() - startedAt });
        return res.status(404).json({ error: 'Empresa não encontrada.' });
      }

      if (!podeAcessarEmpresa(req, empresa.id)) {
        await logPdfGeneration(db, { empresa_id: empresa.id, empresa_nome: empresa.nome_empresa, status: 'forbidden', error: 'Sem permissão', auth_mode: authMode, duration_ms: Date.now() - startedAt });
        return res.status(403).json({ error: 'Sem permissão para baixar este relatório.' });
      }

      const plan = String(empresa.plan || '').toLowerCase();
      const trial = isTrialPlan(plan) || isTrialPlan(String(empresa.status || ''));
      if (!planTemPdf(plan) && !trial) {
        await logPdfGeneration(db, { empresa_id: empresa.id, empresa_nome: empresa.nome_empresa, status: 'forbidden', error: `Plano ${plan} sem PDF`, auth_mode: authMode, duration_ms: Date.now() - startedAt });
        return res.status(403).json({ error: 'Relatório PDF não disponível neste plano.', plan });
      }

      const monthCheck = validateReportMonth(req.query.mes, {
        defaultToCurrent: true,
        minYear: 2020,
        allowFutureMonths: 0,
      });
      if (!monthCheck.ok) {
        await logPdfGeneration(db, { empresa_id: empresa.id, empresa_nome: empresa.nome_empresa, status: 'error', error: monthCheck.error, auth_mode: authMode, duration_ms: Date.now() - startedAt });
        return res.status(400).json({ error: monthCheck.error, exemplo: '2026-09' });
      }

      const mesAno = monthCheck.value;
      const cachePlan = trial ? 'trial' : plan;
      const cached = readPdfCache(empresa.id, mesAno, cachePlan);
      if (cached) {
        await logPdfGeneration(db, { empresa_id: empresa.id, empresa_nome: empresa.nome_empresa, mes: mesAno, status: 'ok', bytes: cached.length, auth_mode: `${authMode}_cache`, duration_ms: Date.now() - startedAt });
        const slug = empresa.slug || empresa.id.slice(0, 8);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="relatorio-${slug}-${mesAno}.pdf"`);
        res.setHeader('X-PDF-Cache', 'HIT');
        return res.send(cached);
      }

      await ensureUnidadesSchema(db);

      let pdf: Buffer;
      try {
        // Intencionalmente sem callGroq: o download nunca consome tokens de IA.
        pdf = await gerarRelatorioMensalPDF(db, empresa.id, mesAno);
      } catch (error: any) {
        await logPdfGeneration(db, { empresa_id: empresa.id, empresa_nome: empresa.nome_empresa, mes: mesAno, status: 'error', error: error?.message || 'Falha geração PDF', auth_mode: authMode, duration_ms: Date.now() - startedAt });
        throw error;
      }

      writePdfCache(empresa.id, mesAno, cachePlan, pdf);
      await logPdfGeneration(db, { empresa_id: empresa.id, empresa_nome: empresa.nome_empresa, mes: mesAno, status: 'ok', bytes: pdf.length, auth_mode: authMode, duration_ms: Date.now() - startedAt });

      const slug = empresa.slug || empresa.id.slice(0, 8);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="relatorio-${slug}-${mesAno}.pdf"`);
      res.setHeader('X-PDF-Cache', 'MISS');
      return res.send(pdf);
    })
  );
}
