import type { Express, Request, Response } from 'express';
import { getDb } from '../lib/db.js';
import { planoTemRelatorioWhatsApp } from '../lib/plans.js';
import { normalizarWhatsapp } from '../lib/whatsapp.js';
import { buildReportPeriod, getOrGenerateWhatsAppReport } from '../services/whatsappReportService.js';

function authorized(req: Request): boolean { const secret = process.env.JOBS_SECRET?.trim(); if (!secret) return process.env.NODE_ENV !== 'production'; const header = String(req.headers.authorization || ''); const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''; return bearer === secret || String(req.headers['x-jobs-secret'] || '') === secret; }
function dateOnly(iso: string): string { return new Date(iso).toISOString().slice(0, 10); }
function previousMonthSameDay(iso: string): string { const d = new Date(iso), day = d.getUTCDate(); d.setUTCMonth(d.getUTCMonth() - 1, 1); const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, lastDay)); return dateOnly(d.toISOString()); }
function previousDay(iso: string): string { const d = new Date(`${iso}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() - 1); return dateOnly(d.toISOString()); }
function nextMonthAfterDue(iso: string): string { const d = new Date(iso), day = d.getUTCDate(); d.setUTCMonth(d.getUTCMonth() + 1, 1); const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, lastDay)); return d.toISOString(); }

async function sendToN8n(payload: Record<string, unknown>): Promise<boolean> { const url = process.env.N8N_WHATSAPP_REPORT_URL?.trim(); if (!url) return false; const headers: Record<string, string> = { 'content-type': 'application/json' }; const token = process.env.N8N_WHATSAPP_REPORT_TOKEN?.trim(); if (token) headers.authorization = `Bearer ${token}`; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000); try { const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal }); return response.ok; } finally { clearTimeout(timer); } }

export function mountReportJobRoutes(app: Express) {
  app.post('/api/jobs/whatsapp-reports', async (req: Request, res: Response) => {
    if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const db = getDb(); const now = new Date(); const nowIso = now.toISOString();
      const rows = await db.all(`SELECT e.id,e.nome_empresa,e.plan,e.status,e.whatsapp,e.report_next_due_at FROM empresas e WHERE e.status='ativo' AND e.report_next_due_at IS NOT NULL AND e.report_next_due_at<=? ORDER BY e.report_next_due_at ASC LIMIT 100`, [nowIso]);
      const stats = { candidatos: rows.length, enviados: 0, sem_whatsapp: 0, sem_n8n: 0, erros: 0, pulados: 0 }; const n8nConfigured = Boolean(process.env.N8N_WHATSAPP_REPORT_URL?.trim());
      for (const empresa of rows) {
        if (!planoTemRelatorioWhatsApp(empresa.plan)) { stats.pulados++; continue; }
        const whatsapp = normalizarWhatsapp(empresa.whatsapp); if (!whatsapp) { stats.sem_whatsapp++; continue; } if (!n8nConfigured) { stats.sem_n8n++; continue; }
        const dueIso = String(empresa.report_next_due_at), nextDue = nextMonthAfterDue(dueIso);
        const claimed = await db.run(`UPDATE empresas SET report_next_due_at=? WHERE id=? AND report_next_due_at=?`, [nextDue, empresa.id, dueIso]); if (Number(claimed.changes || 0) !== 1) { stats.pulados++; continue; }
        const period = buildReportPeriod('mes', previousMonthSameDay(dueIso), previousDay(dateOnly(dueIso)));
        try {
          const report = await getOrGenerateWhatsAppReport(db, String(empresa.id), period, String(empresa.plan || 'inicial'));
          const accepted = await sendToN8n({ tipo: 'relatorio_reputacao_mensal', cliente_id: String(empresa.id), nome_empresa: empresa.nome_empresa, plano: String(empresa.plan || 'inicial'), whatsapp, periodo: { inicio: period.inicio, fim: period.fim }, texto: report.text, cached: report.cached, tokens: 0, modelo: 'none', automatico: true, vencimento_agendado: dueIso });
          if (!accepted) { await db.run(`UPDATE empresas SET report_next_due_at=? WHERE id=? AND report_next_due_at=?`, [dueIso, empresa.id, nextDue]); console.error(`[REPORT] send_failed cliente=${empresa.id}`); stats.erros++; continue; }
          await db.run(`UPDATE empresas SET report_last_sent_at=? WHERE id=?`, [nowIso, empresa.id]); console.log(`[REPORT] cliente=${empresa.id} plano=${empresa.plan} periodo=${period.chave} automatico=1 cached=${report.cached} tokens=0`); stats.enviados++;
        } catch (error: any) { await db.run(`UPDATE empresas SET report_next_due_at=? WHERE id=? AND report_next_due_at=?`, [dueIso, empresa.id, nextDue]); console.error(`[REPORT] generation_failed cliente=${empresa.id}:`, error?.message || error); stats.erros++; }
      }
      res.json({ success: true, ...stats, n8n_configured: n8nConfigured });
    } catch (e: any) { console.error('jobs/whatsapp-reports:', e?.message || e); res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' }); }
  });
}
