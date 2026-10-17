import type { Express, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { getDb } from '../lib/db.js';
import { planTemRelatorioMensal } from '../lib/plans.js';
import { n8nConfigured, notifyN8nAsync } from '../lib/n8n.js';
import { buildRelatorioProfissional, normalizeDestinatarios } from '../services/relatorioProfissional.js';

export function authorizedMonthlyReportJob(req: Pick<Request, 'headers'>): boolean {
  const secret = process.env.JOBS_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== 'production';
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const supplied = String(req.headers['x-jobs-secret'] || '');
  return bearer === secret || supplied === secret;
}

function currentMonthUtc(): string { return new Date().toISOString().slice(0, 7); }
function previousMonthUtc(): string {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7);
}
function isMonth(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
  return value < currentMonthUtc();
}
function parseDestinations(raw: unknown) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    // Cinto de seguranca do job mensal: a rota manual rejeita >20 destinatarios
    // (400 TOO_MANY_RECIPIENTS); aqui a lista vem do banco e e limitada antes do envio.
    return normalizeDestinatarios({ destinatarios: JSON.parse(raw) }).slice(0, 20);
  } catch { return []; }
}

/** Resolve destinatários sem mascarar falhas de banco como ausência de e-mail. */
export async function resolveMonthlyReportRecipients(db: any, empresaId: string, raw: unknown) {
  let destinatarios = parseDestinations(raw);
  if (!destinatarios.length) {
    const user = await db.get('SELECT email FROM usuarios WHERE empresa_id = ? AND email IS NOT NULL LIMIT 1', [empresaId]);
    if (user?.email) destinatarios = [{ canal: 'email', destino: String(user.email).trim() }];
  }
  return destinatarios;
}

async function ensureMonthlyReportSchema(db: any) {
  try { await db.exec('ALTER TABLE empresas ADD COLUMN IF NOT EXISTS relatorio_destinatarios TEXT'); }
  catch { try { await db.exec('ALTER TABLE empresas ADD COLUMN relatorio_destinatarios TEXT'); } catch { /* coluna já existe ou engine não permite */ } }
  try { await db.exec('ALTER TABLE relatorio_envios_mensais ADD COLUMN report_json TEXT'); } catch { /* coluna já existe ou tabela ainda não foi criada */ }
  await db.exec(`CREATE TABLE IF NOT EXISTS relatorio_envios_mensais (
    id TEXT PRIMARY KEY,
    empresa_id TEXT NOT NULL,
    periodo TEXT NOT NULL,
    status TEXT NOT NULL,
    destinatarios_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    enviado_em TEXT,
    report_json TEXT,
    erro TEXT,
    tentativas INTEGER NOT NULL DEFAULT 0,
    UNIQUE (empresa_id, periodo)
  )`);
}

export function mountMonthlyReportJobsRoutes(app: Express) {
  app.post('/api/jobs/monthly-reports', async (req: Request, res: Response) => {
    if (!authorizedMonthlyReportJob(req)) return res.status(401).json({ error: 'Unauthorized' });
    const requested = String(req.query.mes || req.body?.mes || '');
    const periodo = requested ? requested : previousMonthUtc();
    if (!isMonth(periodo)) return res.status(400).json({ error: 'Informe um mês encerrado no formato YYYY-MM.', code: 'INVALID_REPORT_MONTH' });
    const db = getDb();
    try {
      await ensureMonthlyReportSchema(db);
      const companies = await db.all(
        `SELECT e.id, e.nome_empresa, e.slug, e.plan, e.status, e.relatorio_destinatarios
         FROM empresas e
         WHERE lower(COALESCE(e.plan, '')) IN ('pro','ultra','corporativo','corporate','corp','rei')
           AND lower(COALESCE(e.status, '')) IN ('ativo','active')
         ORDER BY e.id`
      ) as any[];
      const stats = { periodo, candidatos: companies.length, encaminhados: 0, pulados: 0, falhas: 0, sem_destinatario: 0, distribuicao_indisponivel: 0, snapshots_gerados: 0, snapshots_recuperados: 0 };
      for (const empresa of companies) {
        const plan = String(empresa.plan || '').toLowerCase();
        if (!planTemRelatorioMensal(plan)) { stats.pulados++; continue; }
        // Destinatários não podem bloquear a criação do snapshot: a reserva começa com a configuração explícita, mesmo vazia.
        const configuredDestinatarios = parseDestinations(empresa.relatorio_destinatarios);
        const now = new Date().toISOString();
        const id = randomUUID();
        let reservationCreated = false;
        try {
          const inserted = await db.run(
            `INSERT INTO relatorio_envios_mensais (id, empresa_id, periodo, status, destinatarios_json, created_at, updated_at, tentativas)
             VALUES (?, ?, ?, 'processing', ?, ?, ?, 1)
             ON CONFLICT (empresa_id, periodo) DO NOTHING`,
            [id, empresa.id, periodo, JSON.stringify(configuredDestinatarios), now, now]
          );
          reservationCreated = Number(inserted.changes || 0) > 0;
        } catch (error: any) {
          console.warn('[monthly-report] reserva falhou:', error?.message || error);
          stats.falhas++;
          continue;
        }
        const reservation = await db.get('SELECT status, updated_at, report_json FROM relatorio_envios_mensais WHERE empresa_id = ? AND periodo = ?', [empresa.id, periodo]) as any;
        if (reservation?.status === 'accepted') {
          if (reservation.report_json) { stats.pulados++; continue; }
          try {
            const recoveredReport = await buildRelatorioProfissional(db, empresa, periodo);
            const saved = await db.run(
              `UPDATE relatorio_envios_mensais SET report_json = ?, updated_at = ? WHERE empresa_id = ? AND periodo = ? AND status = 'accepted' AND report_json IS NULL`,
              [JSON.stringify(recoveredReport), new Date().toISOString(), empresa.id, periodo]
            );
            if (saved.changes) stats.snapshots_recuperados++;
            else stats.pulados++;
          } catch (error: any) {
            stats.falhas++;
            console.warn('[monthly-report] recuperação de snapshot falhou empresa=' + empresa.id + ':', String(error?.message || error).slice(0, 500));
          }
          continue;
        }
        if (!reservationCreated) {
          const updatedAt = new Date(String(reservation?.updated_at || '')).getTime();
          const staleProcessing = reservation?.status === 'processing' && Number.isFinite(updatedAt) && Date.now() - updatedAt >= 30 * 60 * 1000;
          if (reservation?.status === 'processing' && !staleProcessing) { stats.pulados++; continue; }
          if (!['failed', 'generated'].includes(String(reservation?.status || '')) && !staleProcessing) { stats.pulados++; continue; }
          const expectedStatus = staleProcessing ? 'processing' : String(reservation.status);
          const retry = await db.run(
            `UPDATE relatorio_envios_mensais SET status = 'processing', updated_at = ?, erro = NULL, tentativas = tentativas + 1, destinatarios_json = ?
             WHERE empresa_id = ? AND periodo = ? AND status = ? AND updated_at = ?`,
            [now, JSON.stringify(configuredDestinatarios), empresa.id, periodo, expectedStatus, reservation.updated_at]
          );
          if (!retry.changes) { stats.pulados++; continue; }
        }
        try {
          const report = reservation?.report_json ? JSON.parse(String(reservation.report_json)) : await buildRelatorioProfissional(db, empresa, periodo);
          // Persist the generated snapshot before resolving recipients or attempting delivery.
          const snapshotSaved = await db.run(`UPDATE relatorio_envios_mensais SET report_json = ?, updated_at = ? WHERE empresa_id = ? AND periodo = ? AND status = 'processing'`, [JSON.stringify(report), new Date().toISOString(), empresa.id, periodo]);
          if (snapshotSaved.changes && !reservation?.report_json) stats.snapshots_gerados++;
          const destinatarios = await resolveMonthlyReportRecipients(db, String(empresa.id), empresa.relatorio_destinatarios);
          await db.run(`UPDATE relatorio_envios_mensais SET destinatarios_json = ? WHERE empresa_id = ? AND periodo = ? AND status = 'processing'`, [JSON.stringify(destinatarios), empresa.id, periodo]);
          if (!destinatarios.length) {
            await db.run(`UPDATE relatorio_envios_mensais SET status = 'generated', updated_at = ?, erro = NULL WHERE empresa_id = ? AND periodo = ? AND status = 'processing'`, [new Date().toISOString(), empresa.id, periodo]);
            stats.sem_destinatario++;
            continue;
          }
          if (!n8nConfigured()) {
            await db.run(`UPDATE relatorio_envios_mensais SET status = 'generated', updated_at = ?, erro = NULL WHERE empresa_id = ? AND periodo = ? AND status = 'processing'`, [new Date().toISOString(), empresa.id, periodo]);
            stats.distribuicao_indisponivel++;
            continue;
          }
          const channels = [...new Set(destinatarios.map((d: any) => d.canal))];
          const accepted = await notifyN8nAsync('report.generated', {
            tipo: 'relatorio_profissional_mensal',
            schema_version: report.schema_version,
            empresa_id: String(empresa.id),
            slug: empresa.slug || null,
            nome_empresa: empresa.nome_empresa || 'Empresa',
            plan: empresa.plan,
            periodo,
            report,
            relatorio: report,
            channels,
            destinatarios,
            email: destinatarios.find((d: any) => d.canal === 'email')?.destino || null,
            idempotency_key: 'monthly-professional-report:' + empresa.id + ':' + periodo,
            entrega: 'mensal',
            modelo_ia: report.geracao?.modelo_ia || null,
            tokens: report.geracao?.tokens || 0,
          });
          if (!accepted) throw new Error('Webhook de distribuição não confirmou o recebimento.');
          await db.run(`UPDATE relatorio_envios_mensais SET status = 'accepted', updated_at = ?, enviado_em = ?, erro = NULL WHERE empresa_id = ? AND periodo = ?`, [new Date().toISOString(), new Date().toISOString(), empresa.id, periodo]);
          stats.encaminhados++;
        } catch (error: any) {
          const message = String(error?.message || error).slice(0, 500);
          await db.run(`UPDATE relatorio_envios_mensais SET status = 'failed', updated_at = ?, erro = ? WHERE empresa_id = ? AND periodo = ? AND status <> 'accepted'`, [new Date().toISOString(), message, empresa.id, periodo]);
          stats.falhas++;
          console.warn('[monthly-report] falha empresa=' + empresa.id + ':', message);
        }
      }
      return res.status(stats.falhas || stats.sem_destinatario || stats.distribuicao_indisponivel ? 207 : 200).json({ success: stats.falhas === 0 && stats.sem_destinatario === 0 && stats.distribuicao_indisponivel === 0, partial: stats.falhas > 0 || stats.sem_destinatario > 0 || stats.distribuicao_indisponivel > 0, ...stats, distribuicao_configurada: n8nConfigured(), idempotencia: 'um encaminhamento aceito pelo webhook por empresa e mês; snapshots persistidos independentemente da distribuição' });
    } catch (error: any) {
      console.error('[monthly-report] job falhou:', error?.message || error);
      return res.status(500).json({ error: 'Falha ao processar relatórios mensais.', code: 'MONTHLY_REPORT_JOB_FAILED' });
    }
  });
}
