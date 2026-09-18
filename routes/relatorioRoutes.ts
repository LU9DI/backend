/**
 * Relatório PDF (legado) + Relatório inteligente (texto → n8n).
 */
import type { Express, Response } from 'express';
import { randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { getDb, findEmpresa } from '../lib/db.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validateReportMonth } from '../lib/dateValidation.js';
import { empresaTemPdf, empresaTemRelatorio, planLabel, planTemPdf } from '../lib/plans.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { notifyN8nAsync, n8nConfigured } from '../lib/n8n.js';
import {
  buildRelatorioInteligente,
  normalizeDestinatarios,
} from '../services/relatorioInteligente.js';
import { gerarRelatorioMensalPDF } from '../relatorioPdf.js';
import { subscriptionAnchorDay, cycleRangeForMonth } from '../lib/billingCycle.js';
import { ensureReportPdfSchema, getStoredReport, claimReportGeneration, saveGeneratedReport, releaseReportClaim } from '../lib/reportPdfStore.js';

const sendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitos envios de relatório. Aguarde.' },
});

function podeAcessarEmpresa(req: AuthRequest, empresaId: string): boolean {
  if (isAdminUser(req.user)) return true;
  return Boolean(req.user?.empresa_id && req.user.empresa_id === empresaId);
}

function dateOnly(value: unknown): string | null {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? s : null;
}

function tomorrowUtc(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function mountRelatorioRoutes(app: Express) {
  const getDestinatariosHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
    const empresa = await findEmpresa(req.params.ref);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!podeAcessarEmpresa(req, empresa.id)) return res.status(403).json({ error: 'Sem permissão.' });

    let raw: unknown = null;
    try {
      const row = await getDb().get<{ relatorio_destinatarios?: string }>(
        'SELECT relatorio_destinatarios FROM empresas WHERE id = ?',
        [empresa.id]
      );
      raw = row?.relatorio_destinatarios ?? null;
    } catch {
      raw = null;
    }

    let destinatarios: Array<{ canal: string; destino: string }> = [];
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          destinatarios = parsed
            .map((d: any) => ({
              canal: String(d?.canal ?? d?.channel ?? d?.tipo ?? '').trim().toLowerCase(),
              destino: String(d?.destino ?? d?.destination ?? d?.phone ?? d?.email ?? d?.address ?? '').trim(),
            }))
            .filter((d) => d.canal && d.destino);
        }
      } catch {
        destinatarios = [];
      }
    }

    return res.json({ success: true, ativo: destinatarios.length > 0, destinatarios });
  });

  const saveDestinatariosHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
    const empresa = await findEmpresa(req.params.ref);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!podeAcessarEmpresa(req, empresa.id)) return res.status(403).json({ error: 'Sem permissão.' });
    const destinatarios = normalizeDestinatarios(req.body || {});
    if (destinatarios.length > 20) return res.status(400).json({ error: 'Máximo de 20 destinatários.' });
    await getDb().exec(`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS relatorio_destinatarios TEXT`);
    await getDb().run('UPDATE empresas SET relatorio_destinatarios = ? WHERE id = ?', [JSON.stringify(destinatarios), empresa.id]);
    return res.json({ success: true, ativo: destinatarios.length > 0, destinatarios });
  });

  app.get('/api/empresa/:ref/relatorio/destinatarios', autenticarToken, getDestinatariosHandler);
  app.put('/api/empresa/:ref/relatorio/destinatarios', autenticarToken, saveDestinatariosHandler);
  app.post('/api/empresa/:ref/relatorio/destinatarios', autenticarToken, saveDestinatariosHandler);

  const previewHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
    const empresa = await findEmpresa(req.params.ref);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!podeAcessarEmpresa(req, empresa.id)) return res.status(403).json({ error: 'Sem permissão.' });
    if (!empresaTemRelatorio(empresa)) return res.status(403).json({ error: 'Relatório inteligente não disponível neste plano (Inicial não inclui).', plan: empresa.plan, code: 'PLAN_NO_REPORT' });
    const mesCheck = validateReportMonth(req.query.mes || req.body?.mes, { defaultToCurrent: true, minYear: 2020, allowFutureMonths: 0 });
    const mesAno = mesCheck.ok ? mesCheck.value : new Date().toISOString().slice(0, 7);
    const rel = await buildRelatorioInteligente(getDb(), empresa, mesAno);
    res.json({ success: true, tipo: 'relatorio_inteligente', plano: planLabel(String(empresa.plan || 'trial')), ...rel, n8n_configured: n8nConfigured() });
  });

  app.get('/api/empresa/:ref/relatorio/inteligente', autenticarToken, previewHandler);
  app.get('/api/empresa/:ref/relatorio', autenticarToken, previewHandler);
  app.post('/api/empresa/:ref/relatorio/preview', autenticarToken, sendLimiter, previewHandler);

  const sendHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
    const empresa = await findEmpresa(req.params.ref);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!podeAcessarEmpresa(req, empresa.id)) return res.status(403).json({ error: 'Sem permissão.' });
    if (!empresaTemRelatorio(empresa)) return res.status(403).json({ error: 'Relatório inteligente não disponível neste plano (Inicial não inclui).', plan: empresa.plan, code: 'PLAN_NO_REPORT' });
    const mesCheck = validateReportMonth(req.body?.mes || req.query.mes, { defaultToCurrent: true, minYear: 2020, allowFutureMonths: 0 });
    const mesAno = mesCheck.ok ? mesCheck.value : new Date().toISOString().slice(0, 7);
    let destinatarios = normalizeDestinatarios(req.body || {});
    if (destinatarios.length === 0) {
      try {
        const u = await getDb().get(`SELECT email FROM usuarios WHERE empresa_id = ? AND email IS NOT NULL LIMIT 1`, [empresa.id]);
        if (u?.email) destinatarios = [{ canal: 'email', destino: String(u.email) }];
      } catch { /* */ }
    }
    if (destinatarios.length === 0) return res.status(400).json({ error: 'Informe ao menos um destinatário: email, whatsapp, sms ou destinatarios[{canal,destino}].', code: 'NO_DESTINATARIO' });
    const rel = await buildRelatorioInteligente(getDb(), empresa, mesAno);
    const idempotencyKey = `report:${empresa.id}:${mesAno}:${randomUUID()}`;
    if (!n8nConfigured()) return res.status(503).json({ error: 'n8n não configurado. Defina N8N_WEBHOOK_URL no Render para enviar o relatório.', code: 'N8N_OFF', preview: { subject: rel.subject, texto: rel.texto, metricas: rel.metricas } });
    const ok = await notifyN8nAsync('report.generated', { empresa_id: empresa.id, slug: empresa.slug, nome_empresa: empresa.nome_empresa, plan: empresa.plan, periodo: rel.periodo, subject: rel.subject, message: rel.texto, html: rel.html, relatorio: rel.texto, metricas: rel.metricas, destinatarios, channels: [...new Set(destinatarios.map((d) => d.canal))], email: destinatarios.find((d) => d.canal === 'email')?.destino || null, idempotency_key: idempotencyKey, modelo_ia: 'none', tokens: 0 });
    if (!ok) return res.status(502).json({ error: 'n8n não aceitou o webhook (verifique se o workflow está Active).', code: 'N8N_REJECT', preview: { subject: rel.subject, texto: rel.texto } });
    res.json({ success: true, tipo: 'relatorio_inteligente', enviado: true, destinatarios, periodo: rel.periodo, metricas: rel.metricas, modelo_ia: 'none', tokens: 0, mensagem: 'Relatório gerado e enviado ao n8n para distribuição.' });
  });

  app.post('/api/empresa/:ref/relatorio/enviar', autenticarToken, sendLimiter, sendHandler);
  app.post('/api/empresa/:ref/relatorio/inteligente', autenticarToken, sendLimiter, sendHandler);
  app.post('/api/empresa/:ref/relatorio/send', autenticarToken, sendLimiter, sendHandler);

  // PDF oficial: uma geração por ciclo; depois, downloads ilimitados do mesmo arquivo.
  const serveCyclePdf = asyncHandler(async (req: AuthRequest, res: Response) => {
    const empresa: any = await findEmpresa(req.params.ref);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!podeAcessarEmpresa(req, String(empresa.id))) return res.status(403).json({ error: 'Sem permissão.' });
    if (!planTemPdf(String(empresa.plan || empresa.status || ''))) return res.status(403).json({ error: 'PDF não disponível neste plano.' });
    const mesCheck = validateReportMonth(req.query.mes, { defaultToCurrent: true, minYear: 2020, allowFutureMonths: 0 });
    if (!mesCheck.ok) return res.status(400).json({ error: mesCheck.error });
    const range = cycleRangeForMonth(mesCheck.value, subscriptionAnchorDay(empresa));
    if (new Date(range.startIso).getTime() > Date.now()) return res.status(400).json({ error: 'O ciclo informado ainda não começou.' });
    const langRaw = String(req.query.lang || 'pt').toLowerCase();
    const lang = ['pt', 'en', 'es', 'zh'].includes(langRaw) ? langRaw : 'pt';
    const db = getDb();
    await ensureReportPdfSchema(db);
    const slug = String(empresa.slug || empresa.id).replace(/[^a-z0-9_-]+/gi, '-');
    const sendCached = (base64: string) => {
      const buffer = Buffer.from(base64, 'base64');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="relatorio-' + slug + '-' + range.cycleKey + '.pdf"');
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.setHeader('X-PDF-Generation', 'cached');
      res.setHeader('X-PDF-Cycle', range.cycleKey);
      return res.send(buffer);
    };
    const existing = await getStoredReport(db, String(empresa.id), range.cycleKey);
    if (existing?.status === 'ready' && existing.pdf_base64) return sendCached(existing.pdf_base64);
    const id = randomUUID();
    const claimed = await claimReportGeneration(db, { id, empresaId: String(empresa.id), cycleKey: range.cycleKey, cycleStart: range.startIso, cycleEnd: range.endIso, mesAno: mesCheck.value, lang });
    if (!claimed) {
      const afterClaim = await getStoredReport(db, String(empresa.id), range.cycleKey);
      if (afterClaim?.status === 'ready' && afterClaim.pdf_base64) return sendCached(afterClaim.pdf_base64);
      return res.status(409).json({ error: 'O relatório deste ciclo está sendo gerado. Tente novamente em instantes.', code: 'PDF_PROCESSING', cycle: range.cycleKey });
    }
    try {
      const pdf = await gerarRelatorioMensalPDF(db, String(empresa.id), mesCheck.value, undefined, lang);
      await saveGeneratedReport(db, id, pdf.buffer, lang);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="relatorio-' + slug + '-' + range.cycleKey + '.pdf"');
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.setHeader('X-PDF-Generation', 'new');
      res.setHeader('X-PDF-Cycle', range.cycleKey);
      return res.send(pdf.buffer);
    } catch (e) {
      await releaseReportClaim(db, id);
      throw e;
    }
  });

  app.get('/api/empresa/:ref/relatorio-inteligente.pdf', autenticarToken, serveCyclePdf);

  app.get('/api/empresa/:ref/relatorio.pdf', autenticarToken, serveCyclePdf);

}
