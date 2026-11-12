/**
 * Administração do Filtra Dot: PIN administrativo e sessão exclusiva.
 *
 * Todas as rotas passam pelo gate único (`resolveDotGate`) e, exceto o estado,
 * exigem que a empresa tenha proprietário provisionado e que o usuário
 * autenticado SEJA esse proprietário. O PIN nunca é aceito como parâmetro de
 * autorização de outras rotas: quem autoriza é a sessão emitida aqui.
 */
import type { Express, Request, Response } from 'express';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import rateLimit from 'express-rate-limit';
import { resolveDotGate, type DotGateResult } from '../services/dotAccessGate.js';
import {
  DotAdminError,
  clearDotAdminCookie,
  getActiveDotAdminSession,
  getDotAdminPinState,
  readDotAdminCookie,
  requireDotAdminSession,
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
import {
  getDotBudgetSnapshot,
  listOpenDotReservations,
  reconcileDotBudget,
} from '../services/dotLedger.js';

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
  // A mutação exige o mesmo cabeçalho anti-CSRF das demais operações
  // administrativas: encerrar a sessão de outro usuário/tenant por CSRF é
  // negado antes de qualquer efeito (ver docs/DOT_PRODUCAO.md §7).
  app.delete('/api/dot/admin/session', async (req: Request, res: Response) => {
    try {
      const gate = await resolveDotGate(req);
      if (!gate.allowed) return denyGate(res, gate);
      ensureHeader(req);
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

  // Visão operacional do orçamento do Dot (somente o proprietário): números
  // agregados e reservas abertas. Nenhuma resposta expõe usuário, CNPJ ou
  // conteúdo de avaliação — só identificador, estado e contagem de tokens.
  app.get('/api/dot/admin/budget', async (req: Request, res: Response) => {
    try {
      const gate = await resolveDotGate(req);
      if (!gate.allowed) return denyGate(res, gate);
      ensureOwner(gate);
      const empresaId = gate.empresaId as string;
      const budget = await getDotBudgetSnapshot(empresaId, gate.plan || undefined);
      const open = await listOpenDotReservations(empresaId);
      return res.json({
        ok: true,
        budget,
        open_reservations: open.map((item) => ({
          id: item.id,
          status: item.status,
          tokens_reserved: item.tokens_reserved,
          tokens_estimated: item.tokens_estimated,
          ambiguous: Number(item.ambiguous) === 1,
          provider: item.provider,
          sent_at: item.sent_at,
          created_at: item.created_at,
          expires_at: item.expires_at,
        })),
      });
    } catch (error) {
      return adminFail(res, error);
    }
  });

  // Reconciliação por proprietário de tenant foi desativada: o proprietário
  // é parte interessada no próprio orçamento e não pode declarar o consumo.
  // A consulta continua disponível em GET /api/dot/admin/budget.
  app.post('/api/dot/admin/budget/reconcile', async (req: Request, res: Response) => {
    const gate = await resolveDotGate(req);
    if (!gate.allowed) return denyGate(res, gate);
    ensureOwner(gate);
    return res.status(403).json({
      ok: false,
      error: 'A reconciliação do ledger é exclusiva de operador da plataforma.',
      code: 'DOT_RECONCILE_PLATFORM_ADMIN_REQUIRED',
    });
  });

  // Reconciliação controlada por operador da plataforma. O tenant e a decisão
  // são explicitados no corpo; o ledger ainda valida estado/ambiguidade sob lock.
  app.post('/api/admin/dot/budget/reconcile', autenticarToken, pinSetupLimiter, async (req: AuthRequest, res: Response) => {
    try {
      if (!isAdminUser(req.user)) {
        return res.status(403).json({ ok: false, error: 'Somente operador da plataforma.', code: 'DOT_RECONCILE_PLATFORM_ADMIN_REQUIRED' });
      }
      ensureHeader(req);
      const body = req.body || {};
      const empresaId = typeof body?.empresa_id === 'string' ? body.empresa_id.trim() : '';
      if (!empresaId || empresaId.length > 128) {
        return res.status(400).json({ ok: false, error: 'empresa_id inválido.', code: 'DOT_RECONCILE_BAD_TENANT' });
      }
      const reservationId = Number(body?.reservation_id);
      const decision = String(body?.decision || '');
      if (!Number.isSafeInteger(reservationId) || reservationId <= 0) {
        return res.status(400).json({ ok: false, error: 'reservation_id inválido (inteiro positivo obrigatório).', code: 'DOT_RECONCILE_BAD_ID' });
      }
      if (decision !== 'settle' && decision !== 'release') {
        return res.status(400).json({ ok: false, error: "decision deve ser 'settle' ou 'release'.", code: 'DOT_RECONCILE_BAD_DECISION' });
      }
      const tokensRaw = decision === 'settle' ? body?.tokens : undefined;
      const tokens = tokensRaw === undefined || tokensRaw === null ? null : Number(tokensRaw);
      if (decision === 'settle' && (!Number.isSafeInteger(Number(tokens)) || Number(tokens) <= 0)) {
        return res.status(400).json({ ok: false, error: 'settle exige tokens inteiros maiores que zero.', code: 'DOT_RECONCILE_BAD_TOKENS' });
      }
      const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
      if (reason.length < 10) {
        return res.status(400).json({ ok: false, error: 'Informe o motivo operacional (mínimo de 10 caracteres).', code: 'DOT_RECONCILE_REASON_REQUIRED' });
      }
      if (decision === 'release' && body?.confirm_not_sent !== true) {
        return res.status(400).json({ ok: false, error: 'Confirme que a chamada não foi enviada ao provedor.', code: 'DOT_RECONCILE_NOT_SENT_CONFIRMATION_REQUIRED' });
      }
      const provider = typeof body?.provider === 'string' ? body.provider.slice(0, 20) : null;
      const result = await reconcileDotBudget({
        empresaId,
        reservationId,
        decision: decision as 'settle' | 'release',
        tokens,
        reason,
        provider,
      });
      await writeAudit(getDb(), {
        action: 'dot.budget_reconciled',
        actor_user_id: req.user?.id || null,
        actor_role: 'admin',
        empresa_id: empresaId,
        result: result.ok ? 'ok' : 'error',
        ip: clientIp(req),
        user_agent: String(req.headers['user-agent'] || '').slice(0, 200),
        detail: { reservation_id: reservationId, decision, reason, confirm_not_sent: decision === 'release' ? true : undefined, ok: result.ok },
      });
      if (!result.ok) {
        return res.status(409).json({ ok: false, error: result.reason || 'Reconciliação recusada.', code: 'DOT_RECONCILE_REFUSED' });
      }
      return res.json({ ok: true, result });
    } catch (error) {
      return adminFail(res, error);
    }
  });
}
