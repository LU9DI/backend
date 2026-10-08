/**
 * Relatório profissional — objeto estruturado, visual no painel e distribuição por canais.
 *
 * O relatório estruturado é o formato canônico do produto. A estrutura JSON é a fonte única para
 * painel, e-mail, WhatsApp, SMS/WeChat e futuras camadas de IA.
 */
import type { Express, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb, findEmpresa } from '../lib/db.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validateReportMonth } from '../lib/dateValidation.js';
import { empresaTemRelatorio } from '../lib/plans.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { notifyN8nAsync, n8nConfigured } from '../lib/n8n.js';
import {
  buildRelatorioProfissional,
  normalizeDestinatarios,
} from '../services/relatorioProfissional.js';

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

function reportMonth(req: AuthRequest): { ok: true; value: string } | { ok: false; error: string } {
  const check = validateReportMonth(req.query.mes || req.body?.mes, {
    defaultToCurrent: true,
    minYear: 2020,
    allowFutureMonths: 0,
  });
  return check.ok ? check : check;
}

function planError(empresa: any) {
  return {
    error: 'Relatório profissional não disponível neste plano. O plano Inicial não inclui relatórios.',
    plan: empresa.plan,
    code: 'PLAN_NO_REPORT',
  };
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
        [empresa.id],
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

    try {
      await getDb().exec('ALTER TABLE empresas ADD COLUMN relatorio_destinatarios TEXT');
    } catch {
      // Coluna já existe; idempotência entre SQLite e Postgres.
    }
    await getDb().run(
      'UPDATE empresas SET relatorio_destinatarios = ? WHERE id = ?',
      [JSON.stringify(destinatarios), empresa.id],
    );
    return res.json({ success: true, ativo: destinatarios.length > 0, destinatarios });
  });

  app.get('/api/empresa/:ref/relatorio/destinatarios', autenticarToken, getDestinatariosHandler);
  app.put('/api/empresa/:ref/relatorio/destinatarios', autenticarToken, saveDestinatariosHandler);
  app.post('/api/empresa/:ref/relatorio/destinatarios', autenticarToken, saveDestinatariosHandler);

  const previewHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
    const empresa = await findEmpresa(req.params.ref);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!podeAcessarEmpresa(req, empresa.id)) return res.status(403).json({ error: 'Sem permissão.' });
    if (!empresaTemRelatorio(empresa)) return res.status(403).json(planError(empresa));

    const month = reportMonth(req);
    if (!month.ok) return res.status(400).json({ error: month.error, code: 'INVALID_REPORT_MONTH' });
    const mesAno = month.value;
    const relatorio = await buildRelatorioProfissional(getDb(), empresa, mesAno);

    return res.json({
      success: true,
      tipo: 'relatorio_profissional',
      ...relatorio,
      n8n_configured: n8nConfigured(),
    });
  });

  app.get('/api/empresa/:ref/relatorio', autenticarToken, previewHandler);
  app.get('/api/empresa/:ref/relatorio/inteligente', autenticarToken, previewHandler);
  app.post('/api/empresa/:ref/relatorio/preview', autenticarToken, sendLimiter, previewHandler);

  const sendHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
    const empresa = await findEmpresa(req.params.ref);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!podeAcessarEmpresa(req, empresa.id)) return res.status(403).json({ error: 'Sem permissão.' });
    if (!empresaTemRelatorio(empresa)) return res.status(403).json(planError(empresa));

    const month = reportMonth(req);
    if (!month.ok) return res.status(400).json({ error: month.error, code: 'INVALID_REPORT_MONTH' });
    const mesAno = month.value;
    let destinatarios = normalizeDestinatarios(req.body || {});
    if (destinatarios.length > 20) return res.status(400).json({ error: 'Máximo de 20 destinatários.', code: 'TOO_MANY_RECIPIENTS' });

    if (destinatarios.length === 0) {
      try {
        const u = await getDb().get(
          'SELECT email FROM usuarios WHERE empresa_id = ? AND email IS NOT NULL LIMIT 1',
          [empresa.id],
        );
        if (u?.email) destinatarios = [{ canal: 'email', destino: String(u.email) }];
      } catch {
        /* fallback manual */
      }
    }

    if (destinatarios.length === 0) {
      return res.status(400).json({
        error: 'Informe ao menos um destinatário: email, whatsapp, sms, wechat ou destinatarios[{canal,destino}].',
        code: 'NO_DESTINATARIO',
      });
    }

    const relatorio = await buildRelatorioProfissional(getDb(), empresa, mesAno);
    const channels = [...new Set(destinatarios.map((d) => d.canal))];
    const recipientFingerprint = destinatarios
      .map((d) => `${d.canal}:${d.destino.trim().toLowerCase()}`)
      .sort()
      .join('|');
    const idempotencyKey = `professional-report:${empresa.id}:${mesAno}:${channels.sort().join(',')}:${recipientFingerprint}`;

    if (!n8nConfigured()) {
      return res.status(503).json({
        error: 'Distribuição externa não configurada. O relatório continua disponível no painel.',
        code: 'N8N_OFF',
        preview: {
          tipo: relatorio.tipo,
          periodo: relatorio.periodo,
          plano: relatorio.plano,
          kpis: relatorio.kpis,
          canais: relatorio.canais,
        },
      });
    }

    const ok = await notifyN8nAsync('report.generated', {
      tipo: 'relatorio_profissional',
      schema_version: relatorio.schema_version,
      empresa_id: empresa.id,
      cliente_id: empresa.id,
      slug: empresa.slug,
      nome_empresa: empresa.nome_empresa,
      plan: empresa.plan,
      periodo: relatorio.periodo,
      report: relatorio,
      relatorio: relatorio,
      channels,
      destinatarios,
      email: destinatarios.find((d) => d.canal === 'email')?.destino || null,
      idempotency_key: idempotencyKey,
      modelo_ia: relatorio.geracao.modelo_ia,
      tokens: relatorio.geracao.tokens,
    });

    if (!ok) {
      return res.status(502).json({
        error: 'O canal de distribuição não aceitou o relatório. O relatório continua disponível no painel.',
        code: 'N8N_REJECT',
        preview: { periodo: relatorio.periodo, canais: relatorio.canais },
      });
    }

    return res.json({
      success: true,
      tipo: 'relatorio_profissional',
      enviado: true,
      destinatarios,
      channels,
      periodo: relatorio.periodo,
      kpis: relatorio.kpis,
      plano: relatorio.plano,
      mensagem: 'Relatório profissional gerado e encaminhado para distribuição pelos canais selecionados.',
    });
  });

  app.post('/api/empresa/:ref/relatorio/enviar', autenticarToken, sendLimiter, sendHandler);

  // Compatibilidade explícita com clientes antigos: o formato de arquivo legado foi aposentado.
  // Mantemos as rotas legadas para diferenciar migração (410) de rota inexistente (404).
  const legacyPdfGone = (_req: AuthRequest, res: Response) => res.status(410).json({
    error: 'O formato de arquivo legado foi aposentado. Use /api/empresa/:ref/relatorio para o relatório profissional estruturado.',
    code: 'REPORT_LEGACY_FORMAT_GONE',
    endpoint: '/api/empresa/:ref/relatorio',
  });

  app.get('/api/empresa/:ref/relatorio.pdf', legacyPdfGone);
  app.get('/api/empresa/:ref/relatorio-inteligente.pdf', legacyPdfGone);
  app.post('/api/empresa/:ref/relatorio/inteligente', autenticarToken, sendLimiter, sendHandler);
  app.post('/api/empresa/:ref/relatorio/send', autenticarToken, sendLimiter, sendHandler);
}
