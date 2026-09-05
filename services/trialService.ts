/**
 * Regras de negócio do trial (7 dias).
 * Routes só fazem HTTP; aqui fica a lógica.
 */
import crypto from 'crypto';
import type { Database } from 'sqlite';
import { getDb, slugify, slugUnico } from '../lib/db.js';
import { createUsuarioForEmpresa } from '../passwordResetRoutes.js';

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
};

export type TrialResult = {
  success: true;
  empresa_id: string;
  slug: string;
  link_acesso: string;
  link_painel: string;
  expira_em: string;
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

export async function ativarTrial(input: TrialInput, db: Database = getDb()): Promise<TrialResult> {
  const cnpj = String(input.cnpj);
  const nome = String(input.nome_empresa);
  const email = String(input.email);
  const senha = String(input.senha);
  const googleReviewUrl = input.google_review_url ? String(input.google_review_url) : '';

  const id = crypto.randomUUID();
  const slug = await slugUnico(slugify(nome));
  const criadoEm = new Date();
  const expiraEm = new Date(criadoEm.getTime() + 7 * 24 * 60 * 60 * 1000);

  try {
    await db.run(
      `INSERT INTO empresas (id, cnpj, nome_empresa, slug, google_review_url, status, plan, criado_em, expira_em)
       VALUES (?, ?, ?, ?, ?, 'trial', 'trial', ?, ?)`,
      [
        id,
        cnpj,
        nome,
        slug,
        googleReviewUrl || null,
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

  try {
    await createUsuarioForEmpresa(db, { empresaId: id, cnpj, nome, email, senha });
  } catch (e: any) {
    await db.run('DELETE FROM empresas WHERE id = ?', [id]);
    throw new TrialValidationError(e.message || 'Falha ao criar usuário.');
  }

  return {
    success: true,
    empresa_id: id,
    slug,
    link_acesso: `${APP_URL}/avaliacao/${slug}`,
    link_painel: `${APP_URL}/painel/${slug}`,
    expira_em: expiraEm.toISOString(),
  };
}
