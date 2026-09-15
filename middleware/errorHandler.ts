/**
 * 404 + handler global de erros Express (com correlation id).
 */
import type { Request, Response, NextFunction } from 'express';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: 'Rota não encontrada.',
    request_id: (req as any).requestId || null,
  });
}

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return;

  let status = Number(err?.status || err?.statusCode) || 500;
  if (!Number.isFinite(status) || status < 400 || status > 599) status = 500;

  const rawMsg = String(err?.message || 'Erro na requisição.');
  const requestId = (req as any).requestId || null;

  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'request_error',
      status,
      message: rawMsg,
      request_id: requestId,
      path: req.originalUrl || req.url,
      body: err?.body || undefined,
      stack: err?.stack?.split('\n').slice(0, 8),
    })
  );

  // Sentry opcional (não quebra se não instalado)
  try {
    const Sentry = (global as any).__filtra_sentry;
    if (Sentry?.captureException) {
      Sentry.withScope?.((scope: any) => {
        if (requestId) scope.setTag?.('request_id', requestId);
        scope.setExtra?.('path', req.originalUrl);
        Sentry.captureException(err);
      }) ?? Sentry.captureException(err);
    }
  } catch {
    /* ok */
  }

  const isPaymentish =
    /mercado\s*pago|mp_|pix|paypal|stripe|credencial|access token|public key/i.test(rawMsg) ||
    status === 401 ||
    status === 403 ||
    status === 502;

  const message =
    status >= 500 && !isPaymentish ? 'Erro interno do servidor.' : rawMsg;

  res.status(status).json({
    error: message,
    request_id: requestId,
    ...(status >= 500 && isPaymentish ? { provider: 'payment' } : {}),
  });
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
