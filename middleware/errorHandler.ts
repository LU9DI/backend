/**
 * 404 + handler global de erros Express.
 */
import type { Request, Response, NextFunction } from 'express';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: 'Rota não encontrada.' });
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return;

  const status = Number(err?.status || err?.statusCode) || 500;
  const raw = String(err?.message || 'Erro na requisição.');
  const message = status >= 500 ? 'Erro interno do servidor.' : raw;

  if (status >= 500) {
    console.error('[error]', err?.code || '', raw, err?.stack?.slice?.(0, 400) || err);
  }

  res.status(status).json({
    error: message,
    // detail curto ajuda a diagnosticar trial/billing em produção sem stack
    ...(status >= 500
      ? { detail: raw.slice(0, 240) }
      : process.env.NODE_ENV !== 'production'
        ? { detail: raw }
        : {}),
  });
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
