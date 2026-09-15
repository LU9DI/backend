/**
 * Relatório PDF (legado) + Relatório inteligente (texto → n8n).
 */
import type { Express, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb, findEmpresa } from '../lib/db.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validateReportMonth } from '../lib/dateValidation.js';
import { empresaTemPdf, empresaTemRelatorio, planLabel } from '../lib/plans.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { notifyN8nAsync, n8nConfigured } from '../lib/n8n.js';
import {
  buildRelatorioInteligente,
  normalizeDestinatarios,
} from '../services/relatorioInteligente.js';

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

export function mountRelatorioRoutes(app: Express) {
  // --- Relatório inteligente: preview ---
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
    });
  });

  app.get('/api/empresa/:ref/relatorio/inteligente', autenticarToken, previewHandler);
  app.get('/api/empresa/:ref/relatorio', autenticarToken, previewHandler);
  app.post('/api/empresa/:ref/relatorio/preview', autenticarToken, sendLimiter, previewHandler);

  // --- Envio via n8n (email / whatsapp / sms / wechat) ---
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

    // fallback: e-mail do usuário logado / dono
    if (destinatarios.length === 0) {
      try {
        const u = await getDb().get(
          `SELECT email FROM usuarios WHERE empresa_id = ? AND email IS NOT NULL LIMIT 1`,
          [empresa.id]
        );
        if (u?.email) {
          destinatarios = [{ canal: 'email', destino: String(u.email) }];
        }
      } catch {
        /* */
      }
    }

    if (destinatarios.length === 0) {
      return res.status(400).json({
        error:
          'Informe ao menos um destinatário: email, whatsapp, sms ou destinatarios[{canal,destino}].',
        code: 'NO_DESTINATARIO',
      });
    }

    const rel = await buildRelatorioInteligente(getDb(), empresa, mesAno);

    if (!n8nConfigured()) {
      return res.status(503).json({
        error:
          'n8n não configurado. Defina N8N_WEBHOOK_URL no Render para enviar o relatório.',
        code: 'N8N_OFF',
        preview: {
          subject: rel.subject,
          texto: rel.texto,
          metricas: rel.metricas,
        },
      });
    }

    const ok = await notifyN8nAsync('report.generated', {
      empresa_id: empresa.id,
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
      // atalho e-mail (workflows antigos)
      email: destinatarios.find((d) => d.canal === 'email')?.destino || null,
      modelo_ia: 'none',
      tokens: 0,
    });

    if (!ok) {
      return res.status(502).json({
        error: 'n8n não aceitou o webhook (verifique se o workflow está Active).',
        code: 'N8N_REJECT',
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
      mensagem: 'Relatório gerado e enviado ao n8n para distribuição.',
    });
  });

  app.post('/api/empresa/:ref/relatorio/enviar', autenticarToken, sendLimiter, sendHandler);
  app.post('/api/empresa/:ref/relatorio/inteligente', autenticarToken, sendLimiter, sendHandler);
  app.post('/api/empresa/:ref/relatorio/send', autenticarToken, sendLimiter, sendHandler);

  // --- PDF legado (mantido se o arquivo de geração existir) ---
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
          error: 'PDF não disponível neste plano. Use o relatório inteligente.',
          code: 'USE_RELATORIO_INTELIGENTE',
        });
      }

      // Preferir relatório inteligente se PDF engine não estiver disponível
      try {
        // dynamic import evita quebrar boot se relatorioPdf sumiu
        const mod = await import('../relatorioPdf.js').catch(() => null);
        if (!mod?.gerarRelatorioMensalPDF) {
          return res.status(410).json({
            error: 'PDF descontinuado. Use POST /api/empresa/:ref/relatorio/enviar',
            code: 'PDF_GONE',
          });
        }
        const mesCheck = validateReportMonth(req.query.mes, {
          defaultToCurrent: true,
          minYear: 2020,
          allowFutureMonths: 0,
        });
        if (!mesCheck.ok) {
          return res.status(400).json({ error: mesCheck.error });
        }
        const r = await mod.gerarRelatorioMensalPDF(getDb(), empresa.id, mesCheck.value);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="relatorio-${empresa.slug || 'emp'}-${mesCheck.value}.pdf"`
        );
        return res.send(r.buffer);
      } catch (e: any) {
        return res.status(500).json({
          error: 'Falha ao gerar PDF. Prefira o relatório inteligente.',
          detail: String(e?.message || e).slice(0, 160),
        });
      }
    })
  );
}
