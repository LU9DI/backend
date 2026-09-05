import type { Express, Request, Response } from 'express';
import { findEmpresa } from '../lib/db.js';

export function mountEmpresaRoutes(app: Express) {
  app.get('/api/empresa/:ref/validar', async (req: Request, res: Response) => {
    try {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ valido: false, motivo: 'not_found' });

      const agora = new Date();
      const expira = new Date(empresa.expira_em);

      if ((empresa.status === 'trial' || empresa.status === 'teste') && agora > expira) {
        return res.json({
          valido: false,
          motivo: 'expired',
          nome: empresa.nome_empresa,
          empresa_id: empresa.id,
          slug: empresa.slug,
        });
      }
      if (empresa.status === 'bloqueado') {
        return res.json({ valido: false, motivo: 'inactive', nome: empresa.nome_empresa });
      }

      return res.json({
        valido: true,
        nome: empresa.nome_empresa,
        empresa_id: empresa.id,
        slug: empresa.slug,
        google_review_url: empresa.google_review_url || null,
        plan: empresa.plan,
      });
    } catch (e) {
      console.error('validar:', e);
      res.status(500).json({ error: 'Erro interno.' });
    }
  });
}
