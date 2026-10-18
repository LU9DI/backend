/**
 * Propriedade da empresa (fonte autoritativa `empresa_owners`).
 *
 * Cobre: empresa sem proprietário (fail-closed), provisionamento validado
 * contra o banco (usuário precisa existir e pertencer à empresa), troca de
 * proprietário auditada e idempotência.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDb = path.join(os.tmpdir(), `filtra-owner-${Date.now()}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.SQLITE_DB_PATH = tmpDb;

let getDb: any;
let ownership: typeof import('../lib/empresaOwnership.js');

async function seedEmpresa(id: string) {
  await getDb().run(
    'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
    [
      id,
      'cnpj-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14),
      'Empresa Owner',
      'slug-' + id.slice(0, 8),
      'ativo',
      'rei',
      new Date().toISOString(),
      new Date(Date.now() + 30 * 86400000).toISOString(),
    ],
  );
}

async function seedUsuario(empresaId: string): Promise<string> {
  const id = crypto.randomUUID();
  await getDb().run(
    'INSERT INTO usuarios (id, cnpj, nome_funcionario, empresa_id, senha_hash) VALUES (?,?,?,?,?)',
    [id, '00000000000000', 'Usuário Teste', empresaId, 'hash-de-teste'],
  );
  return id;
}

before(async () => {
  const dbMod = await import('../lib/db.js');
  ownership = await import('../lib/empresaOwnership.js');
  await dbMod.initDB();
  await ownership.ensureEmpresaOwnerSchema();
  getDb = dbMod.getDb;
});

after(() => {
  try {
    fs.unlinkSync(tmpDb);
  } catch {
    /* ok */
  }
});

describe('Propriedade da empresa (empresa_owners)', () => {
  it('empresa sem proprietário provisionado não tem dono — fail-closed', async () => {
    const empresa = crypto.randomUUID();
    await seedEmpresa(empresa);

    assert.equal(await ownership.getEmpresaOwnerUserId(empresa), null);
    assert.equal(await ownership.isEmpresaOwner(empresa, 'qualquer-usuario'), false);
    assert.equal(await ownership.isEmpresaOwner(empresa, null), false);
    assert.equal(await ownership.isEmpresaOwner(empresa, ''), false);
    assert.equal(await ownership.isEmpresaOwner('', 'qualquer-usuario'), false);
  });

  it('provisiona somente usuário que existe e pertence à empresa', async () => {
    const empresa = crypto.randomUUID();
    const outra = crypto.randomUUID();
    await seedEmpresa(empresa);
    await seedEmpresa(outra);
    const userA = await seedUsuario(empresa);
    const userB = await seedUsuario(outra);

    const owner = await ownership.provisionEmpresaOwner(empresa, userA, { source: 'test' });
    assert.equal(owner.user_id, userA);
    assert.equal(await ownership.isEmpresaOwner(empresa, userA), true);
    assert.equal(await ownership.isEmpresaOwner(empresa, 'outro-usuario'), false);

    // Usuário de OUTRA empresa é rejeitado mesmo com id válido.
    await assert.rejects(
      () => ownership.provisionEmpresaOwner(empresa, userB, { source: 'test' }),
      /não pertence a esta empresa/,
    );
    // Usuário inexistente é rejeitado.
    await assert.rejects(
      () => ownership.provisionEmpresaOwner(empresa, 'user-inexistente', { source: 'test' }),
      /Usuário não encontrado/,
    );
    // A propriedade não mudou depois das tentativas inválidas.
    assert.equal(await ownership.isEmpresaOwner(empresa, userA), true);
    assert.equal(await ownership.isEmpresaOwner(empresa, userB), false);
  });

  it('é idempotente, auditado e permite correção explícita do proprietário', async () => {
    const empresa = crypto.randomUUID();
    await seedEmpresa(empresa);
    const userA = await seedUsuario(empresa);
    const userB = await seedUsuario(empresa);

    await ownership.provisionEmpresaOwner(empresa, userA, { source: 'test' });
    await ownership.provisionEmpresaOwner(empresa, userA, { source: 'test' });

    const rows = await getDb().all('SELECT empresa_id, user_id FROM empresa_owners WHERE empresa_id = ?', [
      empresa,
    ]);
    assert.equal(rows.length, 1, 'provisionar duas vezes não duplica a linha');

    const audits = await getDb().all(
      'SELECT action, target FROM audit_logs WHERE empresa_id = ? AND action = ? ORDER BY id ASC',
      [empresa, 'empresa.owner_set'],
    );
    assert.equal(audits.length, 2, 'cada provisionamento é auditado');
    assert.ok(audits.every((row: any) => String(row.target) === userA));

    // Correção explícita (admin da plataforma) transfere a propriedade.
    await ownership.provisionEmpresaOwner(empresa, userB, { source: 'admin', actorUserId: 'admin-1' });
    assert.equal(await ownership.isEmpresaOwner(empresa, userB), true);
    assert.equal(await ownership.isEmpresaOwner(empresa, userA), false);

    const owners = await getDb().all('SELECT * FROM empresa_owners WHERE empresa_id = ?', [empresa]);
    assert.equal(owners.length, 1);
    assert.equal(String(owners[0].provisioned_by), 'admin');
  });
});
