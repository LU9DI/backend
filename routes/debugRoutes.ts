import type { Express, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';

/**
 * Debug route that returns the authenticated user object populated by
 * `autenticarToken` middleware. Useful to confirm that Supabase token
 * validation works and that `req.user` contains the expected fields.
 *
 * Endpoint: GET /api/debug/user
 * Header: Authorization: Bearer <access_token>
 */
export function mountDebugRoutes(app: Express) {
  app.get(
    '/api/debug/user',
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ error: 'Token ausente ou inválido' });
      }
      res.json({ user });
    })
  );
}
