/**
 * Relatório PDF mensal — autenticado, cache em disco, sem tokens de IA.
 * A geração usa métricas determinísticas e validação de integridade.
 */
import type { Express, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb, findEmpresa } from '../lib/db.js';
import { ensureUnidadesSchema } from '../relatorioPdf.js';
import { gerarRelatorioMensalPDFSeguro } from '../relatorioSeguroPdf.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validateReportMonth } from '../lib/dateValidation.js';
import { planTemPdf } from '../lib/plans.js';
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
      const t0 = Date.now();
      const auth_mode = authModeOf(req);
      const db = getDb();

      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) {
        await logPdfGeneration(db, { status: 'error', error: 'Empresa não encontrada', auth_mode, duration_ms: Date.now() - t0 });
        return res.status(404).json({ error: 'Empresa não encontrada.' });
      }

      if (!podeAcessarEmpresa(req, empresa.id)) {
        await logPdfGeneration(db, { empresa_id: empresa.id, empresa_nome: empresa.nome_empresa, status: 'forbidden', error: 'Sem permissão', auth_mode, duration_ms: Date.now() - t0 });
        return res.status(403).json({ error: 'Sem permissão para baixar este relatório.' });
      }

      const plan = String(empresa.plan || '').toLowerCase();
      if (!planTemPdf(plan)) {
        await logPdfGeneration(db, { empresa_id: empresa.id, empresa_nome: empresa.nome_empresa, status: 'forbidden', error: `Plano ${plan} sem PDF`, auth_mode, duration_ms: Date.now() - t0 });
        return res.status(403).json({ error: 'Relatório PDF não disponível neste plano. Faça upgrade.', plan });
      }

      const mesCheck = validateReportMonth(req.query.mes, {
        defaultToCurrent: true,
        minYear: 2020,
        allowFutureMonths: 0,
      });
      if (!mesCheck.ok) {
        await logPdfGeneration(db, { empresa_id: empresa.id, empresa_nome: empresa.nome_empresa, status: 'error', error: mesCheck.error, auth_mode, duration_ms: Date.now() - t0 });
        return res.status(400).json({ error: mesCheck.error, exemplo: '2026-09' });
      }
      const mesAno = mesCheck.value;

      const cached = readPdfCache(empresa.id, mesAno, plan);
      if (cached) {
        await logPdfGeneration(db, { empresa_id: empresa.id, empresa_nome: empresa.nome_empresa, mes: mesAno, status: 'ok', bytes: cached.length, auth_mode: auth_mode + '_cache', duration_ms: Date.now() - t0 });
        const slug = empresa.slug || empresa.id.slice(0, 8);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="relatorio-${slug}-${mesAno}.pdf"`);
        res.setHeader('X-PDF-Cache', 'HIT');
        return res.send(cached);
      }

      await ensureUnidadesSchema(db);

      let pdf: Buffer;
      try {
        pdf = await gerarRelatorioMensalPDFSeguro(db, empresa.id, mesAno);
      } catch (e: any) {
        await logPdfGeneration(db, { empresa_id: empresa.id, empresa_nome: empresa.nome_empresa, mes: mesAno, status: 'error', error: e?.message || 'Falha geração PDF', auth_mode, duration_ms: Date.now() - t0 });
        throw e;
      }

      writePdfCache(empresa.id, mesAno, plan, pdf);
      await logPdfGeneration(db, { empresa_id: empresa.id, empresa_nome: empresa.nome_empresa, mes: mesAno, status: 'ok', bytes: pdf.length, auth_mode, duration_ms: Date.now() - t0 });

      const slug = empresa.slug || empresa.id.slice(0, 8);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="relatorio-${slug}-${mesAno}.pdf"`);
      res.setHeader('X-PDF-Cache', 'MISS');
      return res.send(pdf);
    })
  );
}
