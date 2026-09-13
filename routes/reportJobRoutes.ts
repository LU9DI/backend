import type { Express, Request, Response } from 'express';
import { getDb } from '../lib/db.js';
import { planoTemRelatorioWhatsApp } from '../lib/plans.js';
import { buildReportPeriod, getOrGenerateWhatsAppReport } from '../services/whatsappReportService.js';
import { ensureRuntimeSchema } from '../lib/schemaEnsure.js';
import {
  dispatchReportToN8n,
  n8nConfigured,
  reportIdempotencyKey,
} from '../lib/n8n.js';
import {
  dateOnly,
  nextMonthAfterDue,
  previousDay,
  previousMonthSameDay,
} from '../lib/reportSchedule.js';

function authorized(req: Request): boolean {
  const secret = process.env.JOBS_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== 'production';
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return bearer === secret || String(req.headers['x-jobs-secret'] || '') === secret;
}

export function mountReportJobRoutes(app: Express) {
  app.post('/api/jobs/whatsapp-reports', async (req: Request, res: Response) => {
    if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const db = getDb();
      await ensureRuntimeSchema(db);
      const now = new Date();
      const nowIso = now.toISOString();
      const rows = await db.all(
        `SELECT e.id, e.nome_empresa, e.plan, e.status, e.report_next_due_at
         FROM empresas e
         WHERE e.status = 'ativo'
           AND e.report_next_due_at IS NOT NULL
           AND e.report_next_due_at <= ?
         ORDER BY e.report_next_due_at ASC
         LIMIT 100`,
        [nowIso]
      );

      const stats = {
        candidatos: rows.length,
        enviados: 0,
        sem_destinatarios: 0,
        sem_n8n: 0,
        erros: 0,
        pulados: 0,
      };
      const n8nOk = n8nConfigured();

      for (const empresa of rows) {
        if (!planoTemRelatorioWhatsApp(empresa.plan)) {
          stats.pulados++;
          continue;
        }

        const destinatarios = await db.all(
          `SELECT id, canal, destino, nome FROM relatorio_destinatarios
           WHERE empresa_id = ? AND ativo = 1 ORDER BY criado_em ASC`,
          [empresa.id]
        );

        if (!destinatarios?.length) {
          stats.sem_destinatarios++;
          // mantém pendente até cadastrar destinatário
          continue;
        }

        if (!n8nOk) {
          stats.sem_n8n++;
          continue;
        }

        const dueIso = String(empresa.report_next_due_at);
        const nextDue = nextMonthAfterDue(dueIso);

        // Claim atômico: só 1 worker processa este due
        const claimed = await db.run(
          `UPDATE empresas SET report_next_due_at = ? WHERE id = ? AND report_next_due_at = ?`,
          [nextDue, empresa.id, dueIso]
        );
        if (Number(claimed.changes || 0) !== 1) {
          stats.pulados++;
          continue;
        }

        const period = buildReportPeriod(
          'mes',
          previousMonthSameDay(dueIso),
          previousDay(dateOnly(dueIso))
        );
        const idempotencyKey = reportIdempotencyKey(String(empresa.id), period.chave);

        try {
          // 1 geração → N destinatários
          const report = await getOrGenerateWhatsAppReport(
            db,
            String(empresa.id),
            period,
            String(empresa.plan || 'inicial')
          );

          const payload = {
            tipo: 'relatorio_reputacao_mensal',
            idempotency_key: idempotencyKey,
            cliente_id: String(empresa.id),
            nome_empresa: empresa.nome_empresa,
            plano: String(empresa.plan || 'inicial'),
            destinatarios: destinatarios.map((d: any) => ({
              id: String(d.id),
              canal: String(d.canal),
              destino: String(d.destino),
              nome: d.nome || null,
            })),
            periodo: { inicio: period.inicio, fim: period.fim, chave: period.chave },
            texto: report.text,
            cached: report.cached,
            tokens: 0,
            modelo: 'none',
            automatico: true,
            vencimento_agendado: dueIso,
          };

          const sent = await dispatchReportToN8n(payload);
          if (!sent.ok) {
            // rollback do due — tenta de novo no próximo job
            await db.run(
              `UPDATE empresas SET report_next_due_at = ? WHERE id = ? AND report_next_due_at = ?`,
              [dueIso, empresa.id, nextDue]
            );
            console.error(
              `[REPORT] dispatch_failed cliente=${empresa.id} idempotency=${idempotencyKey} err=${sent.error || sent.status}`
            );
            stats.erros++;
            continue;
          }

          await db.run(`UPDATE empresas SET report_last_sent_at = ? WHERE id = ?`, [
            nowIso,
            empresa.id,
          ]);
          console.log(
            `[REPORT] cliente=${empresa.id} periodo=${period.chave} generated_once=1 cached=${report.cached} tokens=0 recipients=${destinatarios.length} idempotency=${idempotencyKey}`
          );
          stats.enviados++;
        } catch (error: any) {
          await db.run(
            `UPDATE empresas SET report_next_due_at = ? WHERE id = ? AND report_next_due_at = ?`,
            [dueIso, empresa.id, nextDue]
          );
          console.error(`[REPORT] generation_failed cliente=${empresa.id}:`, error?.message || error);
          stats.erros++;
        }
      }

      res.json({ success: true, ...stats, n8n_configured: n8nOk });
    } catch (e: any) {
      console.error('jobs/whatsapp-reports:', e?.message || e);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  });
}
