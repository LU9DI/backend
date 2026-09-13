/** Relatório profissional via WhatsApp: conteúdo escalonado pelo plano, sem IA. */
import type { Express, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb, findEmpresa } from '../lib/db.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { verifyInboundSecret } from '../lib/n8n.js';
import { ensureReviewFraudColumns } from '../lib/reviewFraud.js';
import { buildReportPeriod, ensureReportCacheSchema, getOrGenerateWhatsAppReport } from '../services/whatsappReportService.js';

const reportLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas solicitações de relatório. Aguarde um pouco.' } });
function authReport(req: AuthRequest, res: Response, next: NextFunction) { const secret = String(req.headers['x-filtra-secret'] || req.headers['x-n8n-secret'] || '').trim(); if (secret && verifyInboundSecret(secret)) { (req as AuthRequest & { reportAuth?: string }).reportAuth = 'n8n'; return next(); } return autenticarToken(req, res, next); }
function podeAcessarEmpresa(req: AuthRequest & { reportAuth?: string }, empresaId: string): boolean { if (req.reportAuth === 'n8n') return true; if (isAdminUser(req.user)) return true; return Boolean(req.user?.empresa_id && req.user.empresa_id === empresaId); }

export function mountRelatorioRoutes(app: Express) {
  app.get('/api/reports/whatsapp/:clienteId', reportLimiter, authReport, asyncHandler(async (req: AuthRequest & { reportAuth?: string }, res: Response) => {
    const t0 = Date.now();
    const clienteRef = String(req.params.clienteId || '').trim();
    if (!clienteRef || clienteRef.length > 160) return res.status(400).json({ error: 'clienteId inválido.' });
    const db = getDb();
    await ensureReviewFraudColumns(db);
    await ensureReportCacheSchema(db);
    const empresa = await findEmpresa(clienteRef);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!podeAcessarEmpresa(req, empresa.id)) return res.status(403).json({ error: 'Sem permissão para acessar este relatório.' });
    const plan = String(empresa.plan || '').toLowerCase();
    let periodo;
    try { periodo = buildReportPeriod(req.query.periodo as string | undefined, req.query.inicio as string | undefined, req.query.fim as string | undefined); }
    catch (e: any) { return res.status(400).json({ error: String(e?.message || 'Período inválido.') }); }
    try {
      const result = await getOrGenerateWhatsAppReport(db, empresa.id, periodo, plan);
      const duration = Date.now() - t0;
      console.log(`[REPORT] cliente=${empresa.id} plano=${plan || 'inicial'} periodo=${periodo.chave} cache=${result.cached ? 'HIT' : 'MISS'} tokens=0 duration_ms=${duration}`);
      return res.json({ success: true, cliente_id: empresa.id, plano: plan, periodo: { tipo: periodo.tipo, inicio: periodo.inicio, fim: periodo.fim }, cached: result.cached, tokens: 0, modelo: 'none', texto: result.text });
    } catch (e: any) {
      console.error(`[REPORT] generation_failed cliente=${empresa.id} periodo=${periodo.chave}`);
      return res.status(502).json({ success: false, error: 'Não foi possível gerar o relatório agora. Tente novamente em instantes.' });
    }
  }));
}
