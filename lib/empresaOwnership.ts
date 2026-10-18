/**
 * Propriedade da empresa — fonte autoritativa no servidor.
 *
 * A propriedade NÃO é um papel: `role` continua existindo para exibição e
 * fluxos antigos, mas nenhuma rota deve tratá-lo como prova de propriedade.
 * O vínculo confiável nasce em duas situações:
 *
 *  1. cadastro (ativo): o usuário criado junto com a empresa na mesma
 *     operação de signup é o proprietário legítimo (`source: 'signup'`);
 *  2. provisionamento administrativo auditado (empresas legadas, correções),
 *     feito por conta admin da plataforma (`source: 'admin'`).
 *
 * Empresa sem linha aqui = sem proprietário provisionado: tudo que depender
 * de propriedade nega por padrão (fail-closed). Nunca inferimos propriedade
 * por heurística (papel, primeiro usuário, tamanho da tabela etc.).
 */
import type { Database } from 'sqlite';
import { getDb } from './db.js';
import { writeAudit } from './auditLog.js';

export type EmpresaOwner = {
  empresa_id: string;
  user_id: string;
  provisioned_by: string | null;
  created_at: string;
  updated_at: string;
};

let schemaReady = false;

export async function ensureEmpresaOwnerSchema(db?: Database) {
  if (schemaReady) return;
  const target = db || getDb();
  await target.exec(`CREATE TABLE IF NOT EXISTS empresa_owners (
    empresa_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provisioned_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await target.exec('CREATE INDEX IF NOT EXISTS idx_empresa_owners_user ON empresa_owners(user_id)');
  schemaReady = true;
}

function ownershipError(message: string, status: number): Error {
  const error = new Error(message);
  (error as any).status = status;
  return error;
}

export async function getEmpresaOwner(empresaId: string): Promise<EmpresaOwner | null> {
  if (!empresaId) return null;
  await ensureEmpresaOwnerSchema();
  const row = await getDb().get(
    'SELECT empresa_id, user_id, provisioned_by, created_at, updated_at FROM empresa_owners WHERE empresa_id = ? LIMIT 1',
    [empresaId],
  );
  return (row as EmpresaOwner | undefined) || null;
}

export async function getEmpresaOwnerUserId(empresaId: string): Promise<string | null> {
  const owner = await getEmpresaOwner(empresaId);
  return owner ? String(owner.user_id) : null;
}

export async function isEmpresaOwner(empresaId: string, userId?: string | null): Promise<boolean> {
  if (!empresaId || !userId) return false;
  const owner = await getEmpresaOwner(empresaId);
  return Boolean(owner && String(owner.user_id) === String(userId));
}

/**
 * Define (ou corrige) o proprietário da empresa. Sempre valida no banco que o
 * usuário existe e pertence à empresa — nunca aceita vínculos supostos vindos
 * de payloads do cliente. A operação é idempotente e auditada.
 */
export async function provisionEmpresaOwner(
  empresaId: string,
  userId: string,
  opts: {
    actorUserId?: string | null;
    source?: string;
    ip?: string | null;
    userAgent?: string | null;
  } = {},
): Promise<EmpresaOwner> {
  if (!empresaId || !userId) throw ownershipError('Empresa e usuário são obrigatórios.', 400);
  await ensureEmpresaOwnerSchema();
  const db = getDb();

  const empresa = await db.get('SELECT id FROM empresas WHERE id = ? LIMIT 1', [empresaId]);
  if (!empresa) throw ownershipError('Empresa não encontrada.', 404);

  const usuario = await db.get('SELECT id, empresa_id FROM usuarios WHERE id = ? LIMIT 1', [userId]);
  if (!usuario) throw ownershipError('Usuário não encontrado.', 404);
  if (String(usuario.empresa_id) !== String(empresaId)) {
    throw ownershipError('Usuário não pertence a esta empresa.', 400);
  }

  const now = new Date().toISOString();
  const provisionedBy = String(opts.source || 'manual').slice(0, 60);
  const existing = await db.get('SELECT empresa_id FROM empresa_owners WHERE empresa_id = ? LIMIT 1', [
    empresaId,
  ]);
  if (existing) {
    await db.run(
      'UPDATE empresa_owners SET user_id = ?, provisioned_by = ?, updated_at = ? WHERE empresa_id = ?',
      [userId, provisionedBy, now, empresaId],
    );
  } else {
    await db.run(
      'INSERT INTO empresa_owners (empresa_id, user_id, provisioned_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [empresaId, userId, provisionedBy, now, now],
    );
  }

  await writeAudit(db, {
    action: 'empresa.owner_set',
    actor_user_id: opts.actorUserId || null,
    empresa_id: empresaId,
    target: userId,
    result: 'ok',
    ip: opts.ip || null,
    user_agent: opts.userAgent || null,
    detail: { source: provisionedBy },
  });

  const owner = await getEmpresaOwner(empresaId);
  if (!owner) throw ownershipError('Falha ao persistir o proprietário.', 500);
  return owner;
}
