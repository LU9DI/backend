/**
 * Relatório PDF mensal — autenticado, cache memória+disco, SEM tokens de IA.
 * Trial incluso. Otimizado: fingerprint de dados, dedup concorrente, write async.
 */
import type { Express, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb, findEmpresa } from '../lib/db.js';
import {
  gerarRelatorioMensalPDF,
  ensureUnidadesSchema,
  PDF_LAYOUT_VERSION,
} from '../relatorioPdf.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validateReportMonth } from '../lib/dateValidation.js';
import { empresaTemPdf } from '../lib/plans.js';
import { logPdfGeneration } from '../lib/opsLog.js';
import {
  autenticarToken,
  isAdminUser,
  type AuthRequest,
} from '../lib/auth.js';
import {
  readPdfCache,
  writePdfCache,
  withPdfInflight,
} from '../lib/pdfCache.js';

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

/** Contagem leve para invalidar cache quando entram novas avaliações. */
async function reviewFingerprint(
  db: any,
  empresaId: string,
  mesAno: string
): Promise<string> {
  try {
    const row = await db.get(
      `SELECT COUNT(*)::int AS n FROM reviews WHERE empresa_id = $1`,
      [empresaId]
    );
    // fallback sqlite-style
    const n = Number(row?.n ?? row?.count ?? 0);
    return `${n}|${mesAno}`;
  } catch {
    try {
      const row = await db.get(
        `SELECT COUNT(*) AS n FROM reviews WHERE empresa_id = ?`,
        [empresaId]
      );
      return `${Number(row?.n || 0)}|${mesAno}`;
    } catch {
      return `0|${mesAno}`;
    }
  }
}

function sendPdf(
  res: Response,
  pdf: Buffer,
  filename: string,
  cache: 'HIT' | 'MISS'
) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', String(pdf.length));
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-PDF-Cache', cache);
  res.setHeader('X-PDF-Layout', PDF_LAYOUT_VERSION);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(pdf);
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
        await logPdfGeneration(db, {
          empresa_id: empresa.id,
          empresa_nome: empresa.nome_empresa,
          status: 'forbidden',
          error: 'Sem permissão',
          auth_mode,
          duration_ms: Date.now() - t0,
        });
        return res.status(403).json({ error: 'Sem permissão para baixar este relatório.' });
      }

      const plan = String(empresa.plan || empresa.status || 'trial').toLowerCase();
      if (!empresaTemPdf(empresa)) {
        await logPdfGeneration(db, {
          empresa_id: empresa.id,
          empresa_nome: empresa.nome_empresa,
          status: 'forbidden',
          error: `Plano ${plan} sem PDF`,
          auth_mode,
          duration_ms: Date.now() - t0,
        });
        return res.status(403).json({
          error:
            'Relatório PDF não disponível neste plano. Trial e planos Pro+ incluem PDF. Faça upgrade se estiver no Inicial.',
          plan,
          status: empresa.status,
        });
      }

      const mesCheck = validateReportMonth(req.query.mes, {
        defaultToCurrent: true,
        minYear: 2020,
        allowFutureMonths: 0,
      });
      if (!mesCheck.ok) {
        await logPdfGeneration(db, {
          empresa_id: empresa.id,
          empresa_nome: empresa.nome_empresa,
          status: 'error',
          error: mesCheck.error,
          auth_mode,
          duration_ms: Date.now() - t0,
        });
        return res.status(400).json({
          error: mesCheck.error,
          exemplo: '2026-09',
        });
      }
      const mesAno = mesCheck.value;
      const slug = empresa.slug || empresa.id.slice(0, 8);
      const filename = `relatorio-${slug}-${mesAno}.pdf`;

      const cachePlan = `${plan || 'trial'}|${PDF_LAYOUT_VERSION}`;
      const fingerprint = await reviewFingerprint(db, empresa.id, mesAno);

      const cached = readPdfCache(empresa.id, mesAno, cachePlan, fingerprint);
      if (cached) {
        await logPdfGeneration(db, {
          empresa_id: empresa.id,
          empresa_nome: empresa.nome_empresa,
          mes: mesAno,
          status: 'ok',
          bytes: cached.length,
          auth_mode: auth_mode + '_cache',
          duration_ms: Date.now() - t0,
        });
        return sendPdf(res, cached, filename, 'HIT');
      }

      // schema só se ainda não garantido — barato com IF NOT EXISTS
      await ensureUnidadesSchema(db);

      let pdf: Buffer;
      try {
        pdf = await withPdfInflight(empresa.id, mesAno, cachePlan, fingerprint, () =>
          gerarRelatorioMensalPDF(db, empresa.id, mesAno)
        );
      } catch (e: any) {
        await logPdfGeneration(db, {
          empresa_id: empresa.id,
          empresa_nome: empresa.nome_empresa,
          mes: mesAno,
          status: 'error',
          error: e?.message || 'Falha geração PDF',
          auth_mode,
          duration_ms: Date.now() - t0,
        });
        console.error('[pdf] geração falhou:', e?.message || e);
        return res.status(500).json({
          error: 'Falha ao gerar o PDF. Tente novamente em instantes.',
          detail: String(e?.message || e).slice(0, 200),
        });
      }

      writePdfCache(empresa.id, mesAno, cachePlan, pdf, fingerprint);

      await logPdfGeneration(db, {
        empresa_id: empresa.id,
        empresa_nome: empresa.nome_empresa,
        mes: mesAno,
        status: 'ok',
        bytes: pdf.length,
        auth_mode,
        duration_ms: Date.now() - t0,
      });

      return sendPdf(res, pdf, filename, 'MISS');
    })
  );
}
