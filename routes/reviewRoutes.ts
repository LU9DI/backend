import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb, findEmpresa } from '../lib/db.js';
import { validateBody, schemaReview } from '../middleware/validate.js';
import { gerarRespostaReview, gerarTagsSemanticas, aiConfigured } from '../groqService.js';
import { planTemIA, getFeedbackLimit, contarReviewsMes } from '../quota.js';

const reviewsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 40,
  message: { error: 'Muitas avaliações. Tente mais tarde.' },
});

export function mountReviewRoutes(app: Express) {
  app.post(
    '/api/reviews',
    reviewsLimiter,
    validateBody(schemaReview),
    async (req: Request, res: Response) => {
      try {
        const db = getDb();
        const name = req.body.name ? String(req.body.name) : '';
        const comment = req.body.comment ? String(req.body.comment) : '';
        const rating = Number(req.body.rating);
        const empresaRef = String(req.body.empresa_id || req.body.empresa_ref || '').slice(0, 100);

        let empresaId: string | null = null;
        let nomeEmpresa: string | undefined;
        let plan = 'trial';

        if (empresaRef) {
          const emp = await findEmpresa(empresaRef);
          if (!emp) return res.status(404).json({ error: 'Empresa não encontrada.' });
          empresaId = emp.id;
          nomeEmpresa = emp.nome_empresa;
          plan = String(emp.plan || emp.status || 'trial').toLowerCase();

          const usadas = await contarReviewsMes(empresaId);
          const limite = getFeedbackLimit(plan);
          if (usadas >= limite) {
            return res.status(429).json({
              error: `Limite mensal de avaliações atingido (${limite}). Faça upgrade do plano.`,
            });
          }
        }

        let aiReply: string | null = null;
        let aiTags: string | null = null;

        // Notas baixas + plano com IA + qualquer provider (Groq e/ou Gemini)
        if (rating <= 3 && comment && planTemIA(plan) && aiConfigured()) {
          try {
            const [resposta, tags] = await Promise.all([
              gerarRespostaReview(name || 'Anônimo', rating, comment, nomeEmpresa),
              gerarTagsSemanticas(rating, comment),
            ]);
            aiReply = resposta || null;
            aiTags = tags?.length ? JSON.stringify(tags) : null;
          } catch (e: any) {
            console.warn('IA review (não bloqueia envio):', e?.message || e);
          }
        } else if (rating <= 3 && comment) {
          aiTags = JSON.stringify(
            rating <= 2 ? ['#ExperienciaNegativa'] : ['#Neutro']
          );
        }

        const result = await db.run(
          `INSERT INTO reviews (empresa_id, name, rating, comment, ai_reply, ai_tags)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [empresaId, name || 'Anônimo', rating, comment || null, aiReply, aiTags]
        );

        res.status(201).json({
          success: true,
          id: result.lastID,
          ai: Boolean(aiReply),
        });
      } catch (e) {
        console.error('reviews:', e);
        res.status(500).json({ error: 'Erro interno.' });
      }
    }
  );

  app.get('/api/reviews/:ref', async (req: Request, res: Response) => {
    try {
      const emp = await findEmpresa(req.params.ref);
      if (!emp) return res.status(404).json({ error: 'Empresa não encontrada.' });
      const rows = await getDb().all(
        `SELECT id, name, rating, comment, ai_reply, ai_tags, createdAt
         FROM reviews WHERE empresa_id = ? ORDER BY createdAt DESC LIMIT 100`,
        [emp.id]
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: 'Erro interno.' });
    }
  });
}
