import type { Express, Request, Response } from 'express';
import { getDb, findEmpresa } from '../lib/db.js';
import { normalizarWhatsapp, linkWhatsapp } from '../lib/whatsapp.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const APP_URL = process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000';

function nivelDashboard(plan: string): 'basico' | 'pro' | 'ultra' | 'executivo' {
  const p = String(plan || 'trial').toLowerCase();
  if (p === 'rei' || p === 'corporativo') return 'executivo';
  if (p === 'ultra') return 'ultra';
  if (p === 'pro') return 'pro';
  return 'basico';
}

function serieUltimosDias(
  reviews: { rating: number; createdAt: string }[],
  dias = 14
): { dia: string; total: number; positivas: number; negativas: number; media: number }[] {
  const map = new Map<string, { total: number; pos: number; neg: number; soma: number }>();
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  for (let i = dias - 1; i >= 0; i--) {
    const d = new Date(hoje);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    map.set(key, { total: 0, pos: 0, neg: 0, soma: 0 });
  }

  for (const r of reviews) {
    const key = String(r.createdAt || '').slice(0, 10);
    const bucket = map.get(key);
    if (!bucket) continue;
    const rating = Number(r.rating) || 0;
    bucket.total += 1;
    bucket.soma += rating;
    if (rating >= 4) bucket.pos += 1;
    if (rating <= 3) bucket.neg += 1;
  }

  return [...map.entries()].map(([dia, b]) => ({
    dia,
    total: b.total,
    positivas: b.pos,
    negativas: b.neg,
    media: b.total ? Math.round((b.soma / b.total) * 10) / 10 : 0,
  }));
}

export function mountEmpresaRoutes(app: Express) {
  app.get(
    '/api/empresa/:ref/validar',
    asyncHandler(async (req: Request, res: Response) => {
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

      const wpp = normalizarWhatsapp(empresa.whatsapp_suporte);
      return res.json({
        valido: true,
        nome: empresa.nome_empresa,
        empresa_id: empresa.id,
        slug: empresa.slug,
        google_review_url: empresa.google_review_url || null,
        whatsapp: wpp,
        whatsapp_url: linkWhatsapp(wpp),
        plan: empresa.plan,
      });
    })
  );

  app.patch(
    '/api/empresa/:ref/whatsapp',
    asyncHandler(async (req: Request, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });

      const raw = String(req.body.whatsapp || req.body.whatsapp_suporte || '').trim();
      if (!raw) {
        await getDb().run(`UPDATE empresas SET whatsapp_suporte = NULL WHERE id = ?`, [empresa.id]);
        return res.json({ success: true, whatsapp: null, whatsapp_url: null });
      }

      const normalizado = normalizarWhatsapp(raw);
      if (!normalizado) {
        return res.status(400).json({
          error: 'WhatsApp inválido. Use DDD + número (ex: 11999998888 ou +55 11 99999-8888).',
        });
      }

      await getDb().run(`UPDATE empresas SET whatsapp_suporte = ? WHERE id = ?`, [
        normalizado,
        empresa.id,
      ]);

      res.json({
        success: true,
        whatsapp: normalizado,
        whatsapp_url: linkWhatsapp(normalizado),
      });
    })
  );

  app.get(
    '/api/empresa/:ref/painel',
    asyncHandler(async (req: Request, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) {
        return res.status(404).json({ error: 'Empresa não encontrada.' });
      }

      const db = getDb();
      const rows = await db.all(
        `SELECT id, name, rating, comment, ai_reply, ai_tags, createdAt
         FROM reviews WHERE empresa_id = ? ORDER BY createdAt DESC LIMIT 500`,
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

      const dist = [0, 0, 0, 0, 0];
      for (const r of reviews) {
        const n = Number(r.rating);
        if (n >= 1 && n <= 5) dist[n - 1] += 1;
      }

      const ha24h = Date.now() - 24 * 60 * 60 * 1000;
      const crises_24h = reviews.filter(
        (r: any) => r.rating <= 2 && new Date(r.createdAt).getTime() >= ha24h
      ).length;

      const tagCount: Record<string, number> = {};
      for (const r of reviews) {
        for (const t of r.ai_tags || []) {
          const k = String(t);
          tagCount[k] = (tagCount[k] || 0) + 1;
        }
      }
      const top_tags = Object.entries(tagCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([tag, count]) => ({ tag, count }));

      const serie_14d = serieUltimosDias(reviews, 14);

      const plan = String(empresa.plan || 'trial').toLowerCase();
      const nivel = nivelDashboard(plan);
      const pdf_disponivel = ['pro', 'ultra', 'corporativo', 'rei'].includes(plan);

      const base = APP_URL.replace(/\/$/, '');
      const ref = empresa.slug || empresa.id;
      const wpp = normalizarWhatsapp(empresa.whatsapp_suporte);

      res.json({
        empresa: {
          id: empresa.id,
          slug: empresa.slug,
          nome_empresa: empresa.nome_empresa,
          status: empresa.status,
          plan: empresa.plan,
          expira_em: empresa.expira_em,
          google_review_url: empresa.google_review_url || null,
          whatsapp: wpp,
          whatsapp_url: linkWhatsapp(wpp),
        },
        reviews: reviews.slice(0, 200),
        metricas: {
          total,
          media,
          negativas,
          positivas,
          alerta_crise: crises_24h >= 3,
          crises_24h,
          distribuicao: dist,
          top_tags,
          taxa_positiva: total ? Math.round((positivas / total) * 100) : 0,
          serie_14d,
        },
        dashboard: {
          nivel,
          pdf_disponivel,
          mostrar_graficos: true,
          mostrar_tendencia: nivel !== 'basico',
          mostrar_tags: nivel === 'ultra' || nivel === 'executivo',
          mostrar_crise: nivel !== 'basico',
        },
        links: {
          avaliacao: `${base}/avaliacao/${ref}`,
          painel: `${base}/painel/${ref}`,
          widget: `${base}/widget/${ref}`,
          embed: `${base}/avaliacao/${ref}`,
          relatorio_pdf: pdf_disponivel ? `/api/empresa/${ref}/relatorio.pdf` : null,
        },
      });
    })
  );
}
