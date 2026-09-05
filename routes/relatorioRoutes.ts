/**
 * Relatório PDF mensal.
 */
import type { Express, Request, Response } from 'express';
import { getDb, findEmpresa } from '../lib/db.js';
import { gerarRelatorioMensalPDF, ensureUnidadesSchema } from '../relatorioPdf.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validateReportMonth } from '../lib/dateValidation.js';
import { planTemPdf } from '../lib/plans.js';
import { logPdfGeneration } from '../lib/opsLog.js';
import { extrairToken, verifyAccessToken } from '../lib/auth.js';

function detectAuthMode(req: Request): string {
  try {
    const token = extrairToken(req);
    if (!token) return 'publico';
    const payload = verifyAccessToken(token);
    if (payload?.empresa_id === 'admin' || payload?.role === 'admin') return 'jwt_admin';
    if (payload?.empresa_id) return 'jwt_cliente';
    return 'jwt';
  } catch {
    return 'token_invalido';
  }
}

export function mountRelatorioRoutes(app: Express) {
  app.get(
    '/api/empresa/:ref/relatorio.pdf',
    asyncHandler(async (req: Request, res: Response) => {
      const t0 = Date.now();
      const auth_mode = detectAuthMode(req);
      const db = getDb();

      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) {
        await logPdfGeneration(db, {
          status: 'error',
          error: 'Empresa não encontrada',
          auth_mode,
          duration_ms: Date.now() - t0,
        });
        return res.status(404).json({ error: 'Empresa não encontrada.' });
      }

      const plan = String(empresa.plan || '').toLowerCase();
      if (!planTemPdf(plan)) {
        await logPdfGeneration(db, {
          empresa_id: empresa.id,
          empresa_nome: empresa.nome_empresa,
          status: 'forbidden',
          error: `Plano ${plan} sem PDF`,
          auth_mode,
          duration_ms: Date.now() - t0,
        });
        return res.status(403).json({
          error:
            'Relatório PDF não disponível neste plano. Use o seletor de plano no painel (modo teste) ou faça upgrade.',
          plan,
        });
      }

      const mesCheck = validateReportMonth(req.query.mes, {
        defaultToCurrent: true,
        minYear: 2020,
        allowFutureMonths: 0,
      });
      if (!mesCheck.ok) {
        await logPdfGeneration(db, {
          empresa_id: empresa.id,
          empresa_nome: empresa.nome_empresa,
          status: 'error',
          error: mesCheck.error,
          auth_mode,
          duration_ms: Date.now() - t0,
        });
        return res.status(400).json({
          error: mesCheck.error,
          exemplo: '2026-09',
        });
      }
      const mesAno = mesCheck.value;

      await ensureUnidadesSchema(db);

      const precisaNormalize = ['inicial', 'trial', 'teste'].includes(plan);
      const planOriginal = empresa.plan;
      if (precisaNormalize) {
        await db.run(`UPDATE empresas SET plan = 'pro' WHERE id = ?`, [empresa.id]);
      }

      let pdf: Buffer;
      try {
        pdf = await gerarRelatorioMensalPDF(db, empresa.id, mesAno);
      } catch (e: any) {
        await logPdfGeneration(db, {
          empresa_id: empresa.id,
          empresa_nome: empresa.nome_empresa,
          mes: mesAno,
          status: 'error',
          error: e?.message || 'Falha geração PDF',
          auth_mode,
          duration_ms: Date.now() - t0,
        });
        if (precisaNormalize) {
          await db.run(`UPDATE empresas SET plan = ? WHERE id = ?`, [planOriginal, empresa.id]);
        }
        throw e;
      } finally {
        if (precisaNormalize) {
          await db.run(`UPDATE empresas SET plan = ? WHERE id = ?`, [planOriginal, empresa.id]);
        }
      }

      await logPdfGeneration(db, {
        empresa_id: empresa.id,
        empresa_nome: empresa.nome_empresa,
        mes: mesAno,
        status: 'ok',
        bytes: pdf.length,
        auth_mode,
        duration_ms: Date.now() - t0,
      });

      const slug = empresa.slug || empresa.id.slice(0, 8);
      const filename = `relatorio-${slug}-${mesAno}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(pdf);
    })
  );
}
