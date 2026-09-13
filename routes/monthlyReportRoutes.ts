import type { Express, Request, Response } from 'express';
import { getDb, findEmpresa } from '../lib/db.js';
import { planTemPdf } from '../lib/plans.js';
import { getCycleForDate, cycleEnded } from '../lib/reportCycle.js';
import { ensureMonthlyReportSchema, getMonthlyReport } from '../lib/monthlyReportStore.js';
import { generateMonthlyReport } from '../services/monthlyReportService.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';

function authorizedJob(req: Request): boolean {
  const secret = process.env.JOBS_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== 'production';
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const custom = String(req.headers['x-jobs-secret'] || '').trim();
  const q = String(req.query.secret || '').trim();
  return bearer === secret || custom === secret || q === secret;
}

function canAccess(req: AuthRequest, empresaId: string): boolean {
  if (isAdminUser(req.user)) return true;
  return Boolean(req.user?.empresa_id && req.user.empresa_id === empresaId);
}

export function mountMonthlyReportRoutes(app: Express) {
  app.post('/api/jobs/monthly-reports', async (req: Request, res: Response) => {
    if (!authorizedJob(req)) return res.status(401).json({ error: 'Unauthorized' });

    const db = getDb();
    await ensureMonthlyReportSchema(db);

    const now = new Date();
    const empresas = await db.all(
      `SELECT id, nome_empresa, slug, plan, status, criado_em, locale
         FROM empresas
        WHERE status = 'ativo'
          AND plan IN ('pro', 'ultra', 'corporativo', 'rei')
          AND criado_em IS NOT NULL
        ORDER BY criado_em ASC`
    );

    const stats = { candidatos: empresas.length, gerados: 0, ja_existiam: 0, sem_ciclo_fechado: 0, erros: 0 };
    const errors: Array<{ empresa: string; error: string }> = [];

    for (const empresa of empresas || []) {
      try {
        if (!planTemPdf(empresa.plan)) continue;
        const current = getCycleForDate(empresa.criado_em, now);
        const previousReference = new Date(current.start.getTime() - 1);
        const closed = getCycleForDate(empresa.criado_em, previousReference);
        if (!cycleEnded(closed, now)) {
          stats.sem_ciclo_fechado++;
          continue;
        }

        const result = await generateMonthlyReport(db, empresa, closed);
        if (result.alreadyExists) stats.ja_existiam++;
        else stats.gerados++;
      } catch (e: any) {
        stats.erros++;
        errors.push({ empresa: empresa.nome_empresa || empresa.id, error: String(e?.message || e) });
      }
    }

    res.json({ success: stats.erros === 0, ...stats, errors });
  });

  app.get('/api/empresa/:ref/relatorios/:cycleKey.pdf', autenticarToken, async (req: AuthRequest, res: Response) => {
    const empresa = await findEmpresa(req.params.ref);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!canAccess(req, empresa.id)) return res.status(403).json({ error: 'Sem permissão.' });
    if (!planTemPdf(empresa.plan)) return res.status(403).json({ error: 'Plano sem relatório PDF.' });

    const db = getDb();
    await ensureMonthlyReportSchema(db);
    const report = await getMonthlyReport(db, empresa.id, req.params.cycleKey);
    if (!report || !report.pdf_data) {
      return res.status(404).json({ error: 'Relatório não encontrado para este ciclo.' });
    }

    const pdf = Buffer.isBuffer(report.pdf_data) ? report.pdf_data : Buffer.from(report.pdf_data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${report.file_name || `relatorio-${empresa.slug || empresa.id}-${report.cycle_key}.pdf`}"`);
    res.setHeader('Content-Length', String(pdf.length));
    res.send(pdf);
  });
}
