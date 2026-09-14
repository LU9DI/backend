/**
 * Login de clientes (empresa) — e-mail ou CNPJ/tax_id + senha.
 */
import bcrypt from 'bcryptjs';
import type { Database } from 'sqlite';
import type { Response, Request } from 'express';
import { getDb } from '../lib/db.js';
import { setAuthCookie, signAccessToken } from '../lib/auth.js';
import { writeAudit, clientIp } from '../lib/auditLog.js';
import { normalizarCnpj } from '../lib/cnpj.js';

export type LoginInput = { cnpj?: string; email?: string; senha: string };

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
  const senha = String(input.senha || '');
  const email = String(input.email || '').trim().toLowerCase();
  const cnpjRaw = String(input.cnpj || '').trim();
  const cnpjDigits = normalizarCnpj(cnpjRaw);
  const ip = req ? clientIp(req) : null;
  const ua = req ? String(req.headers['user-agent'] || '').slice(0, 200) : null;

  if (!senha || (!email && !cnpjRaw)) {
    throw new AuthUnauthorizedError();
  }

  let usuario: any = null;

  // 1) Preferência: e-mail
  if (email) {
    try {
      usuario = await db.get(
        'SELECT * FROM usuarios WHERE lower(email) = lower(?) LIMIT 1',
        [email]
      );
    } catch {
      usuario = await db.get('SELECT * FROM usuarios WHERE email = ? LIMIT 1', [email]);
    }
  }

  // 2) CNPJ 14 dígitos ou tax_id como cadastrado
  if (!usuario && cnpjRaw) {
    if (cnpjDigits.length === 14) {
      usuario = await db.get('SELECT * FROM usuarios WHERE cnpj = ?', [cnpjDigits]);
    }
    if (!usuario) {
      usuario = await db.get('SELECT * FROM usuarios WHERE cnpj = ?', [cnpjRaw]);
    }
    if (!usuario) {
      usuario = await db.get('SELECT * FROM usuarios WHERE upper(cnpj) = upper(?)', [
        cnpjRaw,
      ]);
    }
  }

  if (!usuario?.senha_hash) {
    await writeAudit(db, {
      action: 'auth.login_failed',
      result: 'denied',
      target: email || cnpjRaw,
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
      target: email || cnpjRaw,
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
