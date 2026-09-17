/** Relatório inteligente (texto → n8n) + PDF profissional por plano. */
import { randomUUID } from 'node:crypto';
import type { Express, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb, findEmpresa } from '../lib/db.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validateReportMonth } from '../lib/dateValidation.js';
import { empresaTemPdf, empresaTemRelatorio, planLabel, planTemPdf } from '../lib/plans.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { notifyN8nAsync, n8nConfigured } from '../lib/n8n.js';
import { enqueueRetry } from '../lib/retryQueue.js';
import {
  buildRelatorioInteligente,
  normalizeDestinatarios,
} from '../services/relatorioInteligente.js';
import { gerarRelatorioMensalPDF } from '../relatorioPdf.js';

const sendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
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

async function ensureDestinatariosColumn() {
  try {
    await getDb().exec(`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS relatorio_destinatarios TEXT`);
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (!/duplicate column|already exists/i.test(msg)) throw e;
  }
}

export function mountRelatorioRoutes(app: Express) {
  void ensureDestinatariosColumn().catch((e) =>
    console.warn('[relatorio] coluna destinatários:', e?.message || e)
  );

  const getDestinatariosHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
    const empresa = await findEmpresa(req.params.ref);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!podeAcessarEmpresa(req, empresa.id)) return res.status(403).json({ error: 'Sem permissão.' });
    await ensureDestinatariosColumn();
    const saved = await getDb().get<{ relatorio_destinatarios?: string }>(
      'SELECT relatorio_destinatarios FROM empresas WHERE id = ?',
      [empresa.id]
    );
    let destinatarios: Array<{ canal: string; destino: string }> = [];
    if (saved?.relatorio_destinatarios) {
      try {
        const parsed = JSON.parse(saved.relatorio_destinatarios);
        if (Array.isArray(parsed)) destinatarios = normalizeDestinatarios({ destinatarios: parsed });
      } catch {
        /* ignore malformed legacy data */
      }
    }
    return res.json({ success: true, ativo: destinatarios.length > 0, destinatarios });
  });

  const previewHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
    const empresa = await findEmpresa(req.params.ref);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!podeAcessarEmpresa(req, empresa.id)) {
      return res.status(403).json({ error: 'Sem permissão.' });
    }
    if (!empresaTemRelatorio(empresa)) {
      return res.status(403).json({
        error: 'Relatório inteligente não disponível neste plano (Inicial não inclui).',
        plan: empresa.plan,
        code: 'PLAN_NO_REPORT',
      });
    }
    const mesCheck = validateReportMonth(req.query.mes || req.body?.mes, {
      defaultToCurrent: true,
      minYear: 2020,
      allowFutureMonths: 0,
    });
    const mesAno = mesCheck.ok ? mesCheck.value : new Date().toISOString().slice(0, 7);
    const rel = await buildRelatorioInteligente(getDb(), empresa, mesAno);
    res.json({
      success: true,
      tipo: 'relatorio_inteligente',
      plano: planLabel(String(empresa.plan || 'trial')),
      ...rel,
      n8n_configured: n8nConfigured(),
      request_id: (req as any).requestId || null,
    });
  });

  app.get('/api/empresa/:ref/relatorio/inteligente', autenticarToken, previewHandler);
  app.get('/api/empresa/:ref/relatorio', autenticarToken, previewHandler);
  app.post('/api/empresa/:ref/relatorio/preview', autenticarToken, sendLimiter, previewHandler);

  app.get('/api/empresa/:ref/relatorio/destinatarios', autenticarToken, getDestinatariosHandler);

  app.put('/api/empresa/:ref/relatorio/destinatarios', autenticarToken, asyncHandler(async (req: AuthRequest, res: Response) => {
    const empresa = await findEmpresa(req.params.ref);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!podeAcessarEmpresa(req, empresa.id)) {
      return res.status(403).json({ error: 'Sem permissão.' });
    }
    if (!empresaTemRelatorio(empresa)) {
      return res.status(403).json({
        error: 'Relatório inteligente não disponível neste plano.',
        code: 'PLAN_NO_REPORT',
      });
    }

    await ensureDestinatariosColumn();
    const destinatarios = normalizeDestinatarios(req.body || {});
    if (destinatarios.length === 0) {
      return res.status(400).json({
        error: 'Informe pelo menos um destinatário válido.',
        code: 'NO_DESTINATARIO',
      });
    }

    await getDb().run(
      'UPDATE empresas SET relatorio_destinatarios = ? WHERE id = ?',
      [JSON.stringify(destinatarios), empresa.id]
    );

    return res.json({ success: true, ativo: true, destinatarios });
  }));

  const sendHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
    const empresa = await findEmpresa(req.params.ref);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!podeAcessarEmpresa(req, empresa.id)) {
      return res.status(403).json({ error: 'Sem permissão.' });
    }
    if (!empresaTemRelatorio(empresa)) {
      return res.status(403).json({
        error: 'Relatório inteligente não disponível neste plano (Inicial não inclui).',
        plan: empresa.plan,
        code: 'PLAN_NO_REPORT',
      });
    }

    const mesCheck = validateReportMonth(req.body?.mes || req.query.mes, {
      defaultToCurrent: true,
      minYear: 2020,
      allowFutureMonths: 0,
    });
    const mesAno = mesCheck.ok ? mesCheck.value : new Date().toISOString().slice(0, 7);

    let destinatarios = normalizeDestinatarios(req.body || {});
    if (destinatarios.length === 0) {
      try {
        await ensureDestinatariosColumn();
        const saved = await getDb().get<{ relatorio_destinatarios?: string }>(
          'SELECT relatorio_destinatarios FROM empresas WHERE id = ?',
          [empresa.id]
        );
        if (saved?.relatorio_destinatarios) {
          try {
            const parsed = JSON.parse(saved.relatorio_destinatarios);
            if (Array.isArray(parsed)) destinatarios = normalizeDestinatarios({ destinatarios: parsed });
          } catch {
            /* */
          }
        }
      } catch {
        /* */
      }
    }
    if (destinatarios.length === 0) {
      try {
        const u = await getDb().get(
          `SELECT email FROM usuarios WHERE empresa_id = ? AND email IS NOT NULL LIMIT 1`,
          [empresa.id]
        );
        if (u?.email) destinatarios = [{ canal: 'email', destino: String(u.email) }];
      } catch {
        /* */
      }
    }
    if (destinatarios.length === 0) {
      return res.status(400).json({
        error: 'Informe email, telegram, sms ou destinatarios[{canal,destino}].',
        code: 'NO_DESTINATARIO',
      });
    }

    const rel = await buildRelatorioInteligente(getDb(), empresa, mesAno);
    const requestId = (req as any).requestId || null;
    const idempotencyKey = `report:${empresa.id}:${mesAno}:${requestId || randomUUID()}`;

    const payload = {
      event: 'report.generated',
      empresa_id: empresa.id,
      cliente_id: empresa.id,
      slug: empresa.slug,
      nome_empresa: empresa.nome_empresa,
      plan: empresa.plan,
      periodo: rel.periodo,
      subject: rel.subject,
      message: rel.texto,
      html: rel.html,
      relatorio: rel.texto,
      metricas: rel.metricas,
      destinatarios,
      channels: [...new Set(destinatarios.map((d) => d.canal))],
      email: destinatarios.find((d) => d.canal === 'email')?.destino || null,
      modelo_ia: 'none',
      tokens: 0,
      request_id: requestId,
      idempotency_key: idempotencyKey,
    };

    if (!n8nConfigured()) {
      try {
        await enqueueRetry({
          jobType: 'n8n_dispatch',
          dedupeKey: idempotencyKey,
          payload: { event: 'report.generated', body: payload },
          delayMs: 60_000,
        });
      } catch {
        /* ok */
      }
      return res.status(503).json({
        error: 'n8n não configurado. Relatório enfileirado para reentrega quando o webhook estiver ON.',
        code: 'N8N_OFF',
        queued: true,
        request_id: requestId,
        preview: { subject: rel.subject, texto: rel.texto, metricas: rel.metricas },
      });
    }

    const ok = await notifyN8nAsync('report.generated', payload);

    if (!ok) {
      let jobId = 0;
      try {
        jobId = await enqueueRetry({
          jobType: 'n8n_dispatch',
          dedupeKey: idempotencyKey,
          payload: { event: 'report.generated', body: payload },
          delayMs: 20_000,
        });
      } catch (e: any) {
        console.warn('[relatorio] enqueue fail:', e?.message || e);
      }
      return res.status(202).json({
        success: false,
        queued: true,
        retry_job_id: jobId || null,
        error: 'n8n não aceitou agora. Reentrega automática enfileirada.',
        code: 'N8N_QUEUED',
        request_id: requestId,
        preview: { subject: rel.subject, texto: rel.texto },
      });
    }

    res.json({
      success: true,
      tipo: 'relatorio_inteligente',
      enviado: true,
      destinatarios,
      periodo: rel.periodo,
      metricas: rel.metricas,
      modelo_ia: 'none',
      tokens: 0,
      request_id: requestId,
      mensagem: 'Relatório gerado e enviado ao n8n.',
    });
  });

  app.post('/api/empresa/:ref/relatorio/enviar', autenticarToken, sendLimiter, sendHandler);
  app.post('/api/empresa/:ref/relatorio/inteligente', autenticarToken, sendLimiter, sendHandler);
  app.post('/api/empresa/:ref/relatorio/send', autenticarToken, sendLimiter, sendHandler);

  // PDF profissional (layout sample: teal, benefícios, logo, marca d'água)
  app.get('/api/empresa/:ref/relatorio-inteligente.pdf', autenticarToken, asyncHandler(async (req: AuthRequest, res: Response) => {
    const empresa: any = await findEmpresa(req.params.ref);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!podeAcessarEmpresa(req, String(empresa.id))) return res.status(403).json({ error: 'Sem permissão.' });

    if (!planTemPdf(String(empresa.plan || empresa.status || ''))) {
      return res.status(403).json({ error: 'PDF não disponível neste plano.' });
    }

    const inicioParam = dateOnly(req.query.inicio);
    const fimParam = dateOnly(req.query.fim);
    const inicio = inicioParam || '1970-01-01';
    const fim = fimParam || tomorrowUtc();
    if (new Date(`${inicio}T00:00:00Z`) >= new Date(`${fim}T00:00:00Z`)) {
      return res.status(400).json({ error: 'Período do ciclo inválido.' });
    }

    const langRaw = String(req.query.lang || 'pt').toLowerCase();
    const lang = ['pt', 'en', 'es', 'zh'].includes(langRaw) ? langRaw : 'pt';
    const mesAno = fim.slice(0, 7) || inicio.slice(0, 7) || new Date().toISOString().slice(0, 7);
    const pdf = await gerarRelatorioMensalPDF(getDb(), String(empresa.id), mesAno, undefined, lang);
    const slug = String(empresa.slug || empresa.id).replace(/[^a-z0-9_-]+/gi, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="relatorio-${slug}-${fim}.pdf"`);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    res.setHeader('X-PDF-Layout', 'v8-professional');
    return res.send(pdf);
  }));

  app.get(
    '/api/empresa/:ref/relatorio.pdf',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeAcessarEmpresa(req, empresa.id)) {
        return res.status(403).json({ error: 'Sem permissão.' });
      }
      if (!empresaTemPdf(empresa)) {
        return res.status(403).json({
          error: 'PDF não disponível neste plano.',
          code: 'PLAN_NO_PDF',
        });
      }

      const mesCheck = validateReportMonth(req.query.mes, {
        defaultToCurrent: true,
        minYear: 2020,
        allowFutureMonths: 0,
      });
      const mesAno = mesCheck.ok ? mesCheck.value : new Date().toISOString().slice(0, 7);
      const langRaw = String(req.query.lang || 'pt').toLowerCase();
      const lang = ['pt', 'en', 'es', 'zh'].includes(langRaw) ? langRaw : 'pt';

      const pdf = await gerarRelatorioMensalPDF(getDb(), String(empresa.id), mesAno, undefined, lang);
      const slug = String(empresa.slug || empresa.id).replace(/[^a-z0-9_-]+/gi, '-');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="relatorio-${slug}-${mesAno}.pdf"`);
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
      res.setHeader('X-PDF-Layout', 'v8-professional');
      return res.send(pdf);
    })
  );
}
