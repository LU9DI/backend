import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { validateBody, schemaReview } from '../middleware/validate.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  criarReview,
  listarReviews,
  ReviewNotFoundError,
  ReviewQuotaError,
} from '../services/reviewService.js';

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
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const result = await criarReview({
          name: req.body.name ? String(req.body.name) : undefined,
          comment: req.body.comment ? String(req.body.comment) : undefined,
          rating: Number(req.body.rating),
          empresa_id: req.body.empresa_id ? String(req.body.empresa_id) : undefined,
          empresa_ref: req.body.empresa_ref ? String(req.body.empresa_ref) : undefined,
        });
        res.status(201).json(result);
      } catch (e: any) {
        if (e instanceof ReviewNotFoundError || e instanceof ReviewQuotaError) {
          return res.status(e.status).json({ error: e.message });
        }
        if (e?.status) return res.status(e.status).json({ error: e.message });
        throw e;
      }
    })
  );

  app.get(
    '/api/reviews/:ref',
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const rows = await listarReviews(String(req.params.ref));
        res.json(rows);
      } catch (e: any) {
        if (e instanceof ReviewNotFoundError) {
          return res.status(404).json({ error: e.message });
        }
        throw e;
      }
    })
  );
}
