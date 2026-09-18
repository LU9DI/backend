import type { Express, Request, Response } from 'express';
import { getDb, findEmpresa } from '../lib/db.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';

function podeGerirEmpresa(req: AuthRequest, empresaId: string): boolean {
  if (isAdminUser(req.user)) return true;
  return Boolean(req.user?.empresa_id && req.user.empresa_id === empresaId);
}

export function mountEmpresaRoutes(app: Express) {
  app.get(
    '/api/empresa/:ref/validar',
    asyncHandler(async (req: Request, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ valido: false, motivo: 'not_found' });
      return res.json({
        valido: true,
        nome: empresa.nome_empresa,
        empresa_id: empresa.id,
        slug: empresa.slug,
        plan: empresa.plan,
      });
    })
  );

  app.get(
    '/api/empresa/:ref/painel',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerirEmpresa(req, empresa.id)) {
        return res.status(403).json({ error: 'Sem permissão.', code: 'FORBIDDEN_PAINEL' });
      }
      // Temporary minimal response while full routes are restored
      return res.json({
        empresa: {
          id: empresa.id,
          slug: empresa.slug,
          nome_empresa: empresa.nome_empresa,
          status: empresa.status,
          plan: empresa.plan || 'trial',
          expira_em: empresa.expira_em,
        },
        reviews: [],
        metricas: {
          total: 0,
          media: 0,
          negativas: 0,
          positivas: 0,
          distribuicao: [0, 0, 0, 0, 0],
          serie_14d: [],
          top_tags: [],
          feedback_usados: 0,
          feedback_limite: 50,
          tokens_usados: 0,
          tokens_limite: 0,
        },
        dashboard: {
          nivel: 'basico',
          mostrar_graficos: true,
          mostrar_tendencia: true,
          mostrar_tags: false,
        },
        links: {},
        integracoes: {},
      });
    })
  );
}
