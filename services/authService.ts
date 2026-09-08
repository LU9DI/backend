/**
 * Regras de autenticação de clientes (empresa).
 */
import bcrypt from 'bcrypt';
import type { Database } from 'sqlite';
import type { Response, Request } from 'express';
import { getDb } from '../lib/db.js';
import { setAuthCookie, signAccessToken } from '../lib/auth.js';
import { writeAudit, clientIp } from '../lib/auditLog.js';

export type LoginInput = {
  cnpj: string;
  senha: string;
};

export type LoginResult = {
  success: true;
  token: string;
  tokenPayload: {
    id: string;
    nome_funcionario: string;
    empresa_id: string;
  };
};

export class AuthUnauthorizedError extends Error {
  status = 401;
  constructor(message = 'Credenciais inválidas.') {
    super(message);
    this.name = 'AuthUnauthorizedError';
  }
}

export async function loginEmpresa(
  input: LoginInput,
  res: Response,
  db: Database = getDb(),
  req?: Request
): Promise<LoginResult> {
  const cnpj = String(input.cnpj || '').replace(/\D/g, '');
  const senha = String(input.senha || '');
  const ip = req ? clientIp(req) : null;
  const ua = req ? String(req.headers['user-agent'] || '').slice(0, 200) : null;

  if (cnpj.length !== 14 || !senha) {
    throw new AuthUnauthorizedError();
  }

  let usuario: any;
  try {
    usuario = await db.get('SELECT * FROM usuarios WHERE cnpj = ?', [cnpj]);
  } catch (e: any) {
    console.error('[auth] select usuario:', e?.message || e);
    throw e;
  }

  if (!usuario?.senha_hash) {
    await writeAudit(db, {
      action: 'auth.login_failed',
      result: 'denied',
      target: cnpj.slice(0, 14),
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
      target: cnpj.slice(0, 14),
      ip,
      user_agent: ua,
      detail: 'senha inválida',
    });
    throw new AuthUnauthorizedError();
  }

  const tokenPayload = {
    id: usuario.id,
    nome_funcionario: usuario.nome_funcionario,
    empresa_id: usuario.empresa_id,
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

  return { success: true, token, tokenPayload };
}
