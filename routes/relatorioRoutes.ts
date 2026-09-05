/**
 * Relatório PDF mensal por plano.
 */
import type { Express, Request, Response } from 'express';
import { getDb, findEmpresa } from '../lib/db.js';
import { gerarRelatorioMensalPDF, ensureUnidadesSchema } from '../relatorioPdf.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const PLANOS_PDF = new Set(['pro', 'ultra', 'corporativo', 'rei']);

export function mountRelatorioRoutes(app: Express) {
  app.get(
    '/api/empresa/:ref/relatorio.pdf',
    asyncHandler(async (req: Request, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });

      const plan = String(empresa.plan || '').toLowerCase();
      if (!PLANOS_PDF.has(plan)) {
        return res.status(403).json({
          error:
            'Relatório PDF disponível a partir do plano Pro. Faça upgrade para baixar o relatório mensal.',
          plan,
        });
      }

      const now = new Date();
      const mesPadrao = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const mesAno = String(req.query.mes || mesPadrao).slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(mesAno)) {
        return res.status(400).json({ error: 'Parâmetro mes inválido. Use YYYY-MM.' });
      }

      const db = getDb();
      await ensureUnidadesSchema(db);

      const pdf = await gerarRelatorioMensalPDF(db, empresa.id, mesAno);
      const slug = empresa.slug || empresa.id.slice(0, 8);
      const filename = `relatorio-${slug}-${mesAno}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(pdf);
    })
  );
}
