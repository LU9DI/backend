/**
 * Administração do Filtra Dot: PIN administrativo e sessão exclusiva.
 *
 * Todas as rotas passam pelo gate único (`resolveDotGate`) e, exceto o estado,
 * exigem que a empresa tenha proprietário provisionado e que o usuário
 * autenticado SEJA esse proprietário. O PIN nunca é aceito como parâmetro de
 * autorização de outras rotas: quem autoriza é a sessão emitida aqui.
 */
import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { resolveDotGate, type DotGateResult } from '../services/dotAccessGate.js';
import {
  DotAdminError,
  clearDotAdminCookie,
  getActiveDotAdminSession,
  getDotAdminPinState,
  readDotAdminCookie,
  resetDotAdminPin,
  revokeDotAdminSessionByToken,
  setDotAdminCookie,
  setDotAdminPinInitial,
  validateDotPinFormat,
  verifyDotAdminPinForSession,
} from '../services/dotAdminSecurity.js';
import { getEmpresaOwnerUserId } from '../lib/empresaOwnership.js';
import { clientIp, writeAudit } from '../lib/auditLog.js';
import { getDb } from '../lib/db.js';

const unlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Muitas tentativas. Aguarde alguns minutos.' },
});

const pinSetupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Muitas tentativas. Aguarde alguns minutos.' },
});

function adminFail(res: Response, error: unknown) {
  const known = error instanceof DotAdminError;
  const status = known ? error.status : 500;
  if (!known || status >= 500) {
    console.error('[dot admin]', error instanceof Error ? error.message : error);
  }
  const body: Record<string, unknown> = {
    ok: false,
    error:
      error instanceof Error && (known || status < 500)
        ? error.message
        : 'Falha administrativa do Dot. Tente novamente.',
    code: known ? error.code : 'DOT_ADMIN_FAILURE',
  };
  if (known && error.retryAfterMs) body.retry_after_ms = error.retryAfterMs;
  return res.status(status).json(body);
}

function denyGate(res: Response, gate: DotGateResult) {
  return res.status(403).json({ ok: false, error: gate.reason || 'Acesso ao Filtra Dot não liberado.' });
}

/** Somente o proprietário verificado da empresa administra o Dot. */
function ensureOwner(gate: DotGateResult) {
  if (gate.demo) throw new DotAdminError('Disponível apenas para contas autenticadas.', 403, 'DOT_ADMIN_DEMO');
  if (!gate.empresaId || !gate.userId) {
    throw new DotAdminError('Autenticação de empresa é necessária.', 403, 'DOT_ADMIN_AUTH_REQUIRED');
  }
  if (!gate.isOwner) {
    throw new DotAdminError(
      'Somente o proprietário da empresa pode administrar o Dot.',
      403,
      'DOT_OWNER_REQUIRED',
    );
  }
}

/** Cabeçalho anti-CSRF exigido nas mutações administrativas do Dot. */
function ensureHeader(req: Request) {
  if (String((req.headers as any)['x-dot-admin'] || '') !== '1') {
    throw new DotAdminError(
      'Cabeçalho X-Dot-Admin: 1 é obrigatório para operações administrativas do Dot.',
      403,
      'DOT_ADMIN_HEADER_REQUIRED',
    );
  }
}

function metaFromReq(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
  };
}

export function mountDotAdminRoutes(app: Express) {
  // Estado administrativo para a interface: propriedade, PIN e sessão ativa.
  app.get('/api/dot/admin/state', async (req: Request, res: Response) => {
    try {
      const gate = await resolveDotGate(req);
      if (!gate.allowed) return denyGate(res, gate);
      if (gate.demo) {
        return res.status(403).json({ ok: false, error: 'Disponível apenas para contas autenticadas.', code: 'DOT_ADMIN_DEMO' });
      }
      const empresaId = gate.empresaId as string;
      const ownerUserId = await getEmpresaOwnerUserId(empresaId);
      const pin = gate.isOwner ? await getDotAdminPinState(empresaId) : null;
      const session = gate.userId ? await getActiveDotAdminSession(req, empresaId, gate.userId) : null;
      return res.json({
        ok: true,
        is_owner: Boolean(gate.isOwner),
        owner_provisioned: Boolean(ownerUserId),
        pin_configured: pin ? pin.configured : null,
        session_active: Boolean(session),
        session_expires_at: session?.expires_at || null,
        header_required: true,
      });
    } catch (error) {
      return adminFail(res, error);
    }
  });

  // Primeiro cadastro do PIN — exclusivo do proprietário.
  app.post('/api/dot/admin/pin', pinSetupLimiter, async (req: Request, res: Response) => {
    try {
      const gate = await resolveDotGate(req);
      if (!gate.allowed) return denyGate(res, gate);
      ensureOwner(gate);
      ensureHeader(req);
      const formatError = validateDotPinFormat(req.body?.pin);
      if (formatError) throw new DotAdminError(formatError, 400, 'DOT_ADMIN_PIN_FORMAT');
      const result = await setDotAdminPinInitial(
        gate.empresaId as string,
        gate.userId as string,
        String(req.body?.pin),
        metaFromReq(req),
      );
      return res.status(201).json({ ok: true, version: result.version });
    } catch (error) {
      return adminFail(res, error);
    }
  });

  // Redefinição autenticada (senha atual) — invalida as sessões anteriores.
  app.post('/api/dot/admin/pin/reset', pinSetupLimiter, async (req: Request, res: Response) => {
    try {
      const gate = await resolveDotGate(req);
      if (!gate.allowed) return denyGate(res, gate);
      ensureOwner(gate);
      ensureHeader(req);
      const formatError = validateDotPinFormat(req.body?.pin);
      if (formatError) throw new DotAdminError(formatError, 400, 'DOT_ADMIN_PIN_FORMAT');
      const result = await resetDotAdminPin(
        gate.empresaId as string,
        gate.userId as string,
        String(req.body?.pin),
        String(req.body?.senha ?? ''),
        metaFromReq(req),
      );
      return res.json({ ok: true, version: result.version });
    } catch (error) {
      return adminFail(res, error);
    }
  });

  // Desbloqueio: verifica o PIN e emite a sessão administrativa (cookie selado).
  app.post('/api/dot/admin/session', unlockLimiter, async (req: Request, res: Response) => {
    try {
      const gate = await resolveDotGate(req);
      if (!gate.allowed) return denyGate(res, gate);
      ensureOwner(gate);
      ensureHeader(req);
      const result = await verifyDotAdminPinForSession(
        gate.empresaId as string,
        gate.userId as string,
        req.body?.pin,
        metaFromReq(req),
      );
      setDotAdminCookie(res, result.token, result.expires_at);
      return res.json({ ok: true, expires_at: result.expires_at });
    } catch (error) {
      return adminFail(res, error);
    }
  });

  // Bloqueio: revoga a sessão atual (idempotente).
  app.delete('/api/dot/admin/session', async (req: Request, res: Response) => {
    try {
      const gate = await resolveDotGate(req);
      if (!gate.allowed) return denyGate(res, gate);
      const token = readDotAdminCookie(req);
      if (token && gate.empresaId && gate.userId) {
        const revoked = await revokeDotAdminSessionByToken(token, 'lock');
        if (revoked) {
          await writeAudit(getDb(), {
            action: 'dot.admin_session_revoked',
            actor_user_id: gate.userId,
            empresa_id: gate.empresaId,
            result: 'ok',
            ip: clientIp(req),
            user_agent: String(req.headers['user-agent'] || '').slice(0, 200),
            detail: { reason: 'lock' },
          });
        }
      }
      clearDotAdminCookie(res);
      return res.json({ ok: true });
    } catch (error) {
      return adminFail(res, error);
    }
  });
}
