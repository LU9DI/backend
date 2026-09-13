/**
 * Relatório inteligente — ativação e envio multicanal (sem PDF).
 *
 * GET  /api/empresa/:ref/relatorio/destinatarios
 * PUT  /api/empresa/:ref/relatorio/destinatarios
 * POST /api/empresa/:ref/relatorio/enviar
 */
import type { Express, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb, findEmpresa } from '../lib/db.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validateReportMonth } from '../lib/dateValidation.js';
import { planTemRelatorio } from '../lib/plans.js';
import {
  autenticarToken,
  isAdminUser,
  type AuthRequest,
} from '../lib/auth.js';
import {
  listarDestinatarios,
  salvarDestinatarios,
  enviarRelatorioInteligente,
  normalizarCanal,
  type Destinatario,
} from '../services/relatorioInteligenteService.js';

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  message: { error: 'Muitos envios de relatório. Aguarde um pouco.' },
});

function podeAcessarEmpresa(req: AuthRequest, empresaId: string): boolean {
  if (isAdminUser(req.user)) return true;
  return Boolean(req.user?.empresa_id && req.user.empresa_id === empresaId);
}

export function mountRelatorioInteligenteRoutes(app: Express) {
  app.get(
    '/api/empresa/:ref/relatorio/destinatarios',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeAcessarEmpresa(req, empresa.id)) {
        return res.status(403).json({ error: 'Sem permissão.' });
      }
      const db = getDb();
      const list = await listarDestinatarios(db, empresa.id);
      res.json({
        success: true,
        plan_ok: planTemRelatorio(empresa.plan),
        destinatarios: list,
        canais: ['whatsapp', 'sms', 'email', 'wechat'],
      });
    })
  );

  app.put(
    '/api/empresa/:ref/relatorio/destinatarios',
    autenticarToken,
    limiter,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeAcessarEmpresa(req, empresa.id)) {
        return res.status(403).json({ error: 'Sem permissão.' });
      }
      if (!planTemRelatorio(empresa.plan)) {
        return res.status(403).json({
          error: 'Relatório inteligente não disponível neste plano.',
        });
      }
      const raw = Array.isArray(req.body?.destinatarios) ? req.body.destinatarios : [];
      const lista: Destinatario[] = raw
        .map((x: any) => ({
          canal: normalizarCanal(String(x.canal || '')) || ('' as any),
          destino: String(x.destino || ''),
        }))
        .filter((x: Destinatario) => x.canal);

      const db = getDb();
      const result = await salvarDestinatarios(db, empresa.id, lista);
      res.json({ success: true, ...result });
    })
  );

  app.post(
    '/api/empresa/:ref/relatorio/enviar',
    autenticarToken,
    limiter,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeAcessarEmpresa(req, empresa.id)) {
        return res.status(403).json({ error: 'Sem permissão.' });
      }

      const mesCheck = validateReportMonth(req.body?.mes || req.query.mes, {
        defaultToCurrent: true,
        minYear: 2020,
        allowFutureMonths: 0,
      });
      if (!mesCheck.ok) {
        return res.status(400).json({ error: mesCheck.error, exemplo: '2026-09' });
      }

      const lang = String(req.body?.lang || 'pt').toLowerCase().slice(0, 2);
      const raw = Array.isArray(req.body?.destinatarios) ? req.body.destinatarios : undefined;
      const dests = raw
        ?.map((x: any) => ({
          canal: normalizarCanal(String(x.canal || '')) || ('' as any),
          destino: String(x.destino || ''),
        }))
        .filter((x: Destinatario) => x.canal);

      const db = getDb();
      const result = await enviarRelatorioInteligente(db, empresa, {
        mesAno: mesCheck.value,
        lang,
        destinatarios: dests,
      });

      if (!result.ok) {
        return res.status(result.error?.includes('plano') ? 403 : 400).json({
          error: result.error,
          texto: result.texto || undefined,
          n8n: result.n8n,
        });
      }

      res.json({
        success: true,
        message: 'Relatório ativado e enviado aos canais escolhidos via n8n.',
        mes: mesCheck.value,
        lang,
        destinatarios: result.destinatarios,
        preview: result.texto.slice(0, 500),
        n8n: true,
      });
    })
  );
}
