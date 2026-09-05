/**
 * Regras de autenticação de clientes (empresa).
 */
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { Database } from 'sqlite';
import type { Response } from 'express';
import { getDb } from '../lib/db.js';
import { setAuthCookie, requireJwtSecret } from '../lib/auth.js';

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
  db: Database = getDb()
): Promise<LoginResult> {
  const cnpj = String(input.cnpj);
  const senha = String(input.senha);

  const usuario = await db.get('SELECT * FROM usuarios WHERE cnpj = ?', [cnpj]);
  if (!usuario?.senha_hash) throw new AuthUnauthorizedError();

  const ok = await bcrypt.compare(senha, usuario.senha_hash);
  if (!ok) throw new AuthUnauthorizedError();

  const tokenPayload = {
    id: usuario.id,
    nome_funcionario: usuario.nome_funcionario,
    empresa_id: usuario.empresa_id,
  };

  const token = jwt.sign(tokenPayload, requireJwtSecret(), { expiresIn: '1d' });
  setAuthCookie(res, token);

  return { success: true, token, tokenPayload };
}
