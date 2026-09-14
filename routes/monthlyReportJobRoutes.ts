/**
 * Job mensal de relatórios.
 * Deve ser chamado por um scheduler externo (ex.: n8n Schedule Trigger).
 * Authorization: Bearer JOBS_SECRET.
 */
import type { Express, Request, Response } from 'express';
import { getDb } from '../lib/db.js';
import { buildN8nMonthlyReport } from '../lib/n8nReport.js';
import { dispatchN8nEvent } from '../lib/n8n.js';

function authorized(req: Request): boolean {
  const secret = process.env.JOBS_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== 'production';

  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return bearer === secret;
}

function previousMonthUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7);
}

function validMonth(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function mountMonthlyReportJobRoutes(app: Express) {
  app.post('/api/jobs/monthly-reports', async (req: Request, res: Response) => {
    if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

    const mesAno = validMonth(req.body?.mesAno)
      ? req.body.mesAno
      : validMonth(req.query.mesAno)
        ? String(req.query.mesAno)
        : previousMonthUtc();

    try {
      const db = getDb();
      const empresas = await db.all(
        `SELECT id, slug
           FROM empresas
          WHERE status = 'ativo'
          ORDER BY id`
      );

      let enviados = 0;
      let semDestinatario = 0;
      let falhas = 0;
      const erros: Array<{ empresa_id: string; erro: string }> = [];

      for (const empresa of empresas || []) {
        try {
          const payload = await buildN8nMonthlyReport(db, String(empresa.id), mesAno);
          if (!payload) {
            falhas++;
            erros.push({ empresa_id: String(empresa.id), erro: 'empresa não encontrada' });
            continue;
          }

          const recipients = Array.isArray((payload as any).destinatarios)
            ? (payload as any).destinatarios
            : [];
          if (recipients.length === 0) {
            semDestinatario++;
            continue;
          }

          const ok = await dispatchN8nEvent('report.generated', payload, {
            empresaId: String(empresa.id),
            slug: empresa.slug || null,
          });

          if (ok) enviados++;
          else {
            falhas++;
            erros.push({ empresa_id: String(empresa.id), erro: 'n8n não aceitou o evento' });
          }
        } catch (error: any) {
          falhas++;
          erros.push({
            empresa_id: String(empresa.id),
            erro: String(error?.message || error),
          });
        }
      }

      return res.json({
        success: falhas === 0,
        periodo: mesAno,
        candidatos: (empresas || []).length,
        enviados,
        sem_destinatario: semDestinatario,
        falhas,
        erros: erros.slice(0, 50),
      });
    } catch (error: any) {
      console.error('jobs/monthly-reports:', error?.message || error);
      return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  });
}
