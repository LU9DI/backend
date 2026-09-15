/**
 * Validação de secrets em webhooks inbound (n8n → API e similares).
 */
import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

function timingSafeEqualStr(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export function expectedInboundSecret(): string {
  return (
    process.env.N8N_INBOUND_SECRET ||
    process.env.N8N_WEBHOOK_SECRET ||
    process.env.WEBHOOK_SHARED_SECRET ||
    ''
  ).trim();
}

/** Middleware: exige secret em produção se N8N_INBOUND_SECRET estiver setado. */
export function requireWebhookSecret(req: Request, res: Response, next: NextFunction) {
  const expected = expectedInboundSecret();
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      // Em produção sem secret: loga aviso mas não bloqueia rotas públicas de pagamento
      // (PayPal/MP têm assinatura própria). Use só em rotas n8n inbound.
      return next();
    }
    return next();
  }

  const got =
    String(req.headers['x-filtra-secret'] || '').trim() ||
    String(req.headers['x-n8n-secret'] || '').trim() ||
    String(req.headers['x-webhook-secret'] || '').trim();

  if (!got || !timingSafeEqualStr(got, expected)) {
    return res.status(401).json({
      error: 'Secret de webhook inválido ou ausente.',
      request_id: (req as any).requestId || null,
    });
  }
  next();
}
