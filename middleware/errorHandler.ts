/**
 * 404 + handler global de erros Express.
 */
import type { Request, Response, NextFunction } from 'express';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: 'Rota não encontrada.' });
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return;

  let status = Number(err?.status || err?.statusCode) || 500;
  if (!Number.isFinite(status) || status < 400 || status > 599) status = 500;

  const rawMsg = String(err?.message || 'Erro na requisição.');

  // Sempre loga no Render
  console.error('[error]', {
    status,
    message: rawMsg,
    body: err?.body || undefined,
    stack: err?.stack?.split('\n').slice(0, 8),
  });

  const isPaymentish =
    /mercado\s*pago|mp_|pix|paypal|stripe|credencial|access token|public key|unauthorized/i.test(
      rawMsg
    ) ||
    status === 401 ||
    status === 403 ||
    status === 502;

  const message =
    status >= 500 && !isPaymentish ? 'Erro interno do servidor.' : rawMsg;

  res.status(status).json({
    error: message,
    ...(isPaymentish ? { provider: 'mercadopago' } : {}),
  });
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
