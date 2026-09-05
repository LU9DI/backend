/**
 * Relatório PDF mensal — liberado nos 5 planos (Inicial → Rei).
 */
import type { Express, Request, Response } from 'express';
import { getDb, findEmpresa } from '../lib/db.js';
import { gerarRelatorioMensalPDF, ensureUnidadesSchema } from '../relatorioPdf.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validateReportMonth } from '../lib/dateValidation.js';
import { planTemPdf } from '../lib/plans.js';

export function mountRelatorioRoutes(app: Express) {
  app.get(
    '/api/empresa/:ref/relatorio.pdf',
    asyncHandler(async (req: Request, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });

      const plan = String(empresa.plan || '').toLowerCase();
      if (!planTemPdf(plan)) {
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
        return res.status(400).json({
          error: mesCheck.error,
          exemplo: '2026-09',
        });
      }
      const mesAno = mesCheck.value;

      const db = getDb();
      await ensureUnidadesSchema(db);

      const precisaNormalize = ['inicial', 'trial', 'teste'].includes(plan);
      const planOriginal = empresa.plan;
      if (precisaNormalize) {
        await db.run(`UPDATE empresas SET plan = 'pro' WHERE id = ?`, [empresa.id]);
      }

      let pdf: Buffer;
      try {
        pdf = await gerarRelatorioMensalPDF(db, empresa.id, mesAno);
      } finally {
        if (precisaNormalize) {
          await db.run(`UPDATE empresas SET plan = ? WHERE id = ?`, [planOriginal, empresa.id]);
        }
      }

      const slug = empresa.slug || empresa.id.slice(0, 8);
      const filename = `relatorio-${slug}-${mesAno}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(pdf);
    })
  );
}
