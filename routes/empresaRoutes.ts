import type { Express, Request, Response } from 'express';
import { getDb, findEmpresa } from '../lib/db.js';

const APP_URL = process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000';

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

  /** Painel do cliente (slug ou UUID) */
  app.get('/api/empresa/:ref/painel', async (req: Request, res: Response) => {
    try {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) {
        return res.status(404).json({ error: 'Empresa não encontrada.' });
      }

      const db = getDb();
      const rows = await db.all(
        `SELECT id, name, rating, comment, ai_reply, ai_tags, createdAt
         FROM reviews WHERE empresa_id = ? ORDER BY createdAt DESC LIMIT 200`,
        [empresa.id]
      );

      const reviews = (rows || []).map((r: any) => {
        let tags: string[] = [];
        if (r.ai_tags) {
          try {
            const parsed = JSON.parse(r.ai_tags);
            if (Array.isArray(parsed)) tags = parsed.map(String);
          } catch {
            tags = [];
          }
        }
        return {
          id: r.id,
          name: r.name,
          rating: r.rating,
          comment: r.comment,
          ai_reply: r.ai_reply,
          ai_tags: tags,
          createdAt: r.createdAt,
        };
      });

      const total = reviews.length;
      const soma = reviews.reduce((s: number, r: any) => s + Number(r.rating || 0), 0);
      const media = total ? Math.round((soma / total) * 10) / 10 : 0;
      const negativas = reviews.filter((r: any) => r.rating <= 3).length;
      const positivas = reviews.filter((r: any) => r.rating >= 4).length;

      const ha24h = Date.now() - 24 * 60 * 60 * 1000;
      const crises_24h = reviews.filter(
        (r: any) => r.rating <= 2 && new Date(r.createdAt).getTime() >= ha24h
      ).length;

      const base = APP_URL.replace(/\/$/, '');
      const ref = empresa.slug || empresa.id;

      res.json({
        empresa: {
          id: empresa.id,
          slug: empresa.slug,
          nome_empresa: empresa.nome_empresa,
          status: empresa.status,
          plan: empresa.plan,
          expira_em: empresa.expira_em,
          google_review_url: empresa.google_review_url || null,
        },
        reviews,
        metricas: {
          total,
          media,
          negativas,
          positivas,
          alerta_crise: crises_24h >= 3,
          crises_24h,
        },
        links: {
          avaliacao: `${base}/avaliacao/${ref}`,
          painel: `${base}/painel/${ref}`,
          widget: `${base}/widget/${ref}`,
          embed: `${base}/avaliacao/${ref}`,
        },
      });
    } catch (e) {
      console.error('painel:', e);
      res.status(500).json({ error: 'Erro ao carregar o painel.' });
    }
  });
}
