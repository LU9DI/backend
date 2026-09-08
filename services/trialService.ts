/**
 * Regras de negócio do trial (7 dias).
 */
import crypto from 'crypto';
import type { Database } from 'sqlite';
import type { Response } from 'express';
import { getDb, slugify, slugUnico } from '../lib/db.js';
import { createUsuarioForEmpresa } from '../passwordResetRoutes.js';
import { normalizarWhatsapp } from '../lib/whatsapp.js';
import { notificarTrialAtivado } from '../lib/notifications.js';
import { setAuthCookie, signAccessToken } from '../lib/auth.js';

const APP_URL = (process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(
  /\/$/,
  ''
);

export type TrialInput = {
  cnpj: string;
  nome_empresa: string;
  email: string;
  senha: string;
  google_review_url?: string;
  whatsapp?: string;
  locale?: string;
};

export type TrialResult = {
  success: true;
  empresa_id: string;
  slug: string;
  link_acesso: string;
  link_painel: string;
  expira_em: string;
  token?: string;
  tokenPayload?: {
    id: string;
    nome_funcionario: string;
    empresa_id: string;
  };
};

export class TrialConflictError extends Error {
  status = 409;
  constructor(message = 'Este CNPJ já ativou o período de testes.') {
    super(message);
    this.name = 'TrialConflictError';
  }
}

export class TrialValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'TrialValidationError';
  }
}

export async function ativarTrial(
  input: TrialInput,
  db: Database = getDb(),
  res?: Response
): Promise<TrialResult> {
  const cnpj = String(input.cnpj);
  const nome = String(input.nome_empresa);
  const email = String(input.email);
  const senha = String(input.senha);
  const googleReviewUrl = input.google_review_url ? String(input.google_review_url) : '';
  const wpp = normalizarWhatsapp(input.whatsapp || null);

  if (input.whatsapp && String(input.whatsapp).trim() && !wpp) {
    throw new TrialValidationError(
      'WhatsApp inválido. Use DDD + número (ex: 11999998888).'
    );
  }

  const id = crypto.randomUUID();
  const slug = await slugUnico(slugify(nome));
  const criadoEm = new Date();
  const expiraEm = new Date(criadoEm.getTime() + 7 * 24 * 60 * 60 * 1000);

  try {
    await db.run(
      `INSERT INTO empresas (id, cnpj, nome_empresa, slug, google_review_url, whatsapp_suporte, status, plan, criado_em, expira_em)
       VALUES (?, ?, ?, ?, ?, ?, 'trial', 'trial', ?, ?)`,
      [
        id,
        cnpj,
        nome,
        slug,
        googleReviewUrl || null,
        wpp,
        criadoEm.toISOString(),
        expiraEm.toISOString(),
      ]
    );
  } catch (e: any) {
    if (String(e.code) === 'SQLITE_CONSTRAINT') {
      throw new TrialConflictError();
    }
    throw e;
  }

  let usuarioId: string;
  try {
    const u = await createUsuarioForEmpresa(db, { empresaId: id, cnpj, nome, email, senha });
    usuarioId = (u as any)?.id || crypto.randomUUID();
  } catch (e: any) {
    await db.run('DELETE FROM empresas WHERE id = ?', [id]);
    throw new TrialValidationError(e.message || 'Falha ao criar usuário.');
  }

  // Busca usuário real para JWT
  const usuario = await db.get(
    `SELECT id, nome_funcionario, empresa_id FROM usuarios WHERE empresa_id = ? ORDER BY rowid DESC LIMIT 1`,
    [id]
  );

  const tokenPayload = {
    id: String(usuario?.id || usuarioId),
    nome_funcionario: String(usuario?.nome_funcionario || nome),
    empresa_id: id,
  };
  const token = signAccessToken(tokenPayload);
  if (res) setAuthCookie(res, token);

  // E-mail de boas-vindas (não bloqueia a resposta)
  notificarTrialAtivado({
    email,
    nomeEmpresa: nome,
    slug,
    empresaId: id,
    expiraEm: expiraEm.toISOString(),
    locale: input.locale,
  }).catch((e) => console.warn('e-mail trial:', e?.message || e));

  return {
    success: true,
    empresa_id: id,
    slug,
    link_acesso: `${APP_URL}/avaliacao/${slug}`,
    link_painel: `${APP_URL}/painel/${slug}`,
    expira_em: expiraEm.toISOString(),
    token,
    tokenPayload,
  };
}
