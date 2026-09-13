/** Relatório PDF mensal — Puppeteer, layout por plano. */
import type { Express, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb, findEmpresa } from '../lib/db.js';
import {
  gerarRelatorioMensalPDF,
  ensureUnidadesSchema,
  parsePreviewDepth,
  type PdfDepth,
} from '../relatorioPdf.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validateReportMonth } from '../lib/dateValidation.js';
import { empresaTemPdf } from '../lib/plans.js';
import { logPdfGeneration } from '../lib/opsLog.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { readPdfCache, writePdfCache, withPdfInflight } from '../lib/pdfCache.js';

const PDF_LAYOUT_VERSION = 'puppeteer-plan-v3';

const pdfLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitos downloads de PDF deste IP. Aguarde um pouco.' },
});

function podeAcessarEmpresa(req: AuthRequest, empresaId: string): boolean {
  if (isAdminUser(req.user)) return true;
  return Boolean(req.user?.empresa_id && req.user.empresa_id === empresaId);
}

function authModeOf(req: AuthRequest): string {
  if (isAdminUser(req.user)) return 'jwt_admin';
  if (req.user?.empresa_id) return 'jwt_cliente';
  return 'jwt';
}

async function reviewFingerprint(db: any, empresaId: string, mesAno: string): Promise<string> {
  try {
    const row = await db.get(`SELECT COUNT(*)::int AS n FROM reviews WHERE empresa_id = $1`, [
      empresaId,
    ]);
    return `${Number(row?.n ?? row?.count ?? 0)}|${mesAno}`;
  } catch {
    try {
      const row = await db.get(`SELECT COUNT(*) AS n FROM reviews WHERE empresa_id = ?`, [
        empresaId,
      ]);
      return `${Number(row?.n || 0)}|${mesAno}`;
    } catch {
      return `0|${mesAno}`;
    }
  }
}

export function mountRelatorioRoutes(app: Express) {
  app.get(
    '/api/empresa/:ref/relatorio.pdf',
    pdfLimiter,
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const t0 = Date.now();
      const auth_mode = authModeOf(req);
      const db = getDb();
      const empresa = await findEmpresa(req.params.ref);

      if (!empresa) {
        await logPdfGeneration(db, {
          status: 'error',
          error: 'Empresa não encontrada',
          auth_mode,
          duration_ms: Date.now() - t0,
        });
        return res.status(404).json({ error: 'Empresa não encontrada.' });
      }

      if (!podeAcessarEmpresa(req, empresa.id)) {
        return res.status(403).json({ error: 'Sem permissão para baixar este relatório.' });
      }

      const plan = String(empresa.plan || empresa.status || 'trial').toLowerCase();
      if (!empresaTemPdf(empresa)) {
        return res.status(403).json({
          error: 'Relatório PDF não disponível neste plano. Trial e planos Pro+ incluem PDF.',
          plan,
        });
      }

      const mesCheck = validateReportMonth(req.query.mes, {
        defaultToCurrent: true,
        minYear: 2020,
        allowFutureMonths: 0,
      });
      if (!mesCheck.ok) {
        return res.status(400).json({ error: mesCheck.error, exemplo: '2026-09' });
      }
      const mesAno = mesCheck.value;

      const preview: PdfDepth | null = isAdminUser(req.user)
        ? parsePreviewDepth(req.query.preview_plan)
        : null;

      const slug = empresa.slug || empresa.id.slice(0, 8);
      const filename = `relatorio-${slug}-${mesAno}.pdf`;
      const cachePlan = `${plan}|${PDF_LAYOUT_VERSION}|${preview || 'auto'}`;
      const fingerprint = await reviewFingerprint(db, empresa.id, mesAno);

      if (!preview) {
        const cached = readPdfCache(empresa.id, mesAno, cachePlan, fingerprint);
        if (cached) {
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          res.setHeader('X-PDF-Cache', 'HIT');
          res.setHeader('X-PDF-Layout', PDF_LAYOUT_VERSION);
          res.setHeader('X-PDF-Engine', 'puppeteer');
          res.setHeader('X-PDF-Plan', plan);
          return res.send(cached);
        }
      }

      await ensureUnidadesSchema(db);

      let depth: string = plan;
      let planLabelOut = plan;
      let pdf: Buffer;

      try {
        pdf = await withPdfInflight(empresa.id, mesAno, cachePlan, fingerprint, async () => {
          const r = await gerarRelatorioMensalPDF(db, empresa.id, mesAno, undefined, null, {
            forceDepth: preview,
          });
          depth = r.depth;
          planLabelOut = r.planLabel;
          return r.buffer;
        });
      } catch (e: any) {
        console.error('[pdf]', e?.message || e);
        await logPdfGeneration(db, {
          empresa_id: empresa.id,
          empresa_nome: empresa.nome_empresa,
          mes: mesAno,
          status: 'error',
          error: e?.message || 'Falha PDF',
          auth_mode,
          duration_ms: Date.now() - t0,
        });
        return res.status(500).json({
          error: 'Falha ao gerar o PDF.',
          detail: String(e?.message || e).slice(0, 200),
        });
      }

      if (!preview) {
        writePdfCache(empresa.id, mesAno, cachePlan, pdf, fingerprint);
      }

      await logPdfGeneration(db, {
        empresa_id: empresa.id,
        empresa_nome: empresa.nome_empresa,
        mes: mesAno,
        status: 'ok',
        bytes: pdf.length,
        auth_mode,
        duration_ms: Date.now() - t0,
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', String(pdf.length));
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-PDF-Cache', preview ? 'PREVIEW' : 'MISS');
      res.setHeader('X-PDF-Layout', PDF_LAYOUT_VERSION);
      res.setHeader('X-PDF-Engine', 'puppeteer');
      res.setHeader('X-PDF-Plan', depth);
      res.setHeader('X-PDF-Plan-Label', planLabelOut);
      return res.send(pdf);
    })
  );
}
