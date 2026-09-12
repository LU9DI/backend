/** Regras de autenticação de clientes (empresa). */
import bcrypt from 'bcrypt';
import type { Database } from 'sqlite';
import type { Response, Request } from 'express';
import { getDb } from '../lib/db.js';
import { setAuthCookie, signAccessToken } from '../lib/auth.js';
import { writeAudit, clientIp } from '../lib/auditLog.js';
import { empresaTemAcesso } from './billingService.js';
import { canonicalTaxId, isEmailLike, normalizarCnpj } from '../lib/cnpj.js';

export type LoginInput = {
  cnpj?: string;
  email?: string;
  login?: string;
  senha: string;
};

export type LoginResult = {
  success: true;
  token: string;
  tokenPayload: { id: string; nome_funcionario: string; empresa_id: string };
};

export class AuthUnauthorizedError extends Error {
  status = 401;
  constructor(message = 'Credenciais inválidas.') {
    super(message);
    this.name = 'AuthUnauthorizedError';
  }
}

export class AuthAccessDeniedError extends Error {
  status = 403;
  constructor(message = 'Acesso encerrado. Renove a assinatura para continuar.') {
    super(message);
    this.name = 'AuthAccessDeniedError';
  }
}

async function findUsuario(db: Database, identifier: string): Promise<any | null> {
  const raw = String(identifier || '').trim();
  if (!raw) return null;

  if (isEmailLike(raw)) {
    const email = raw.toLowerCase();
    const byEmail = await db.get(`SELECT * FROM usuarios WHERE lower(email) = lower(?) LIMIT 1`, [
      email,
    ]);
    if (byEmail) return byEmail;
  }

  const tax = canonicalTaxId(raw);
  if (tax.length >= 5) {
    const byTax = await db.get(`SELECT * FROM usuarios WHERE cnpj = ? LIMIT 1`, [tax]);
    if (byTax) return byTax;
    const digits = normalizarCnpj(raw);
    if (digits && digits !== tax) {
      const byDigits = await db.get(`SELECT * FROM usuarios WHERE cnpj = ? LIMIT 1`, [digits]);
      if (byDigits) return byDigits;
    }
  }

  return null;
}

export async function loginEmpresa(
  input: LoginInput,
  res: Response,
  db: Database = getDb(),
  req?: Request
): Promise<LoginResult> {
  const senha = String(input.senha || '');
  const identifier = String(input.login || input.email || input.cnpj || '').trim();
  const ip = req ? clientIp(req) : null;
  const ua = req ? String(req.headers['user-agent'] || '').slice(0, 200) : null;

  if (!identifier || !senha) throw new AuthUnauthorizedError();

  const usuario = await findUsuario(db, identifier);
  if (!usuario?.senha_hash) {
    await writeAudit(db, {
      action: 'auth.login_failed',
      result: 'denied',
      target: identifier.slice(0, 64),
      ip,
      user_agent: ua,
      detail: 'usuário não encontrado',
    });
    throw new AuthUnauthorizedError();
  }

  const ok = await bcrypt.compare(senha, usuario.senha_hash);
  if (!ok) {
    await writeAudit(db, {
      action: 'auth.login_failed',
      actor_user_id: usuario.id,
      empresa_id: usuario.empresa_id,
      result: 'denied',
      target: identifier.slice(0, 64),
      ip,
      user_agent: ua,
      detail: 'senha inválida',
    });
    throw new AuthUnauthorizedError();
  }

  if (String(usuario.empresa_id) !== 'admin') {
    const empresa = await db.get('SELECT status, expira_em FROM empresas WHERE id = ?', [
      usuario.empresa_id,
    ]);
    if (!empresa || !empresaTemAcesso(empresa)) {
      await writeAudit(db, {
        action: 'auth.login_denied_access',
        actor_user_id: usuario.id,
        empresa_id: usuario.empresa_id,
        result: 'denied',
        ip,
        user_agent: ua,
        detail: 'empresa sem acesso vigente',
      });
      throw new AuthAccessDeniedError();
    }
  }

  const tokenPayload = {
    id: usuario.id,
    nome_funcionario: usuario.nome_funcionario,
    empresa_id: usuario.empresa_id,
    role:
      usuario.role ||
      (String(usuario.empresa_id) === 'admin' ? 'admin' : 'empresa'),
  };
  const token = signAccessToken(tokenPayload);
  setAuthCookie(res, token);
  await writeAudit(db, {
    action: 'auth.login',
    actor_user_id: usuario.id,
    actor_role: usuario.empresa_id === 'admin' ? 'admin' : 'empresa',
    empresa_id: usuario.empresa_id,
    result: 'ok',
    ip,
    user_agent: ua,
  });
  return {
    success: true,
    token,
    tokenPayload: {
      id: tokenPayload.id,
      nome_funcionario: tokenPayload.nome_funcionario,
      empresa_id: tokenPayload.empresa_id,
    },
  };
}
