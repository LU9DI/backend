/**
 * 404 + handler global de erros Express.
 */
import type { Request, Response, NextFunction } from 'express';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: 'Rota não encontrada.' });
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  // Erros já tratados (ex.: rate limit) às vezes chegam aqui
  if (res.headersSent) return;

  const status = Number(err?.status || err?.statusCode) || 500;
  const message =
    status >= 500
      ? 'Erro interno do servidor.'
      : String(err?.message || 'Erro na requisição.');

  if (status >= 500) {
    console.error('[error]', err);
  }

  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV !== 'production' && status >= 500
      ? { detail: String(err?.message || err) }
      : {}),
  });
}

/** Envolve handlers async para não precisar try/catch em todo lugar. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
