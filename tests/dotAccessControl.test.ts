import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

let sqliteAvailable = true;
try {
  await import('sqlite3');
  await import('sqlite');
} catch {
  sqliteAvailable = false;
}

const accessTest = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !sqliteAvailable }, fn);

import { initDB, getDb } from '../lib/db.js';
import {
  dotAccessAllowed,
  ensureDotAccessSchema,
  ensureDotInternalPermissionBaseline,
  listDotPermissions,
  requireDotAccess,
  setDotPermission,
} from '../services/dotAccessControl.js';

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = '/tmp/filtra-dot-access-control-test.sqlite';

let ready = false;

async function setup() {
  if (ready) return;
  await initDB();
  await ensureDotAccessSchema();
  ready = true;
}

async function reset() {
  await setup();
  const db = getDb();
  await db.run('DELETE FROM dot_agent_permissions');
  await db.run('DELETE FROM dot_access_audit');
}

accessTest('Controle de acesso DOT: permissão é sempre escopada por empresa', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  const outra = crypto.randomUUID();

  await setDotPermission(empresa, { resource: 'operations', action: 'execute', granted: true, grantedBy: 'user-1' });

  assert.equal(await dotAccessAllowed(empresa, 'operations', 'execute', 'user-1'), true);
  // Outra empresa nunca herda a permissão.
  assert.equal(await dotAccessAllowed(outra, 'operations', 'execute', 'user-1'), false);
  // Recurso/ação diferentes continuam negados.
  assert.equal(await dotAccessAllowed(empresa, 'finance', 'execute', 'user-1'), false);
  assert.equal(await dotAccessAllowed(empresa, 'operations', 'read', 'user-1'), false);

  await assert.rejects(
    () => requireDotAccess(outra, 'operations', 'execute', 'user-1'),
    /DOT sem permissão: operations.execute/,
  );
});

accessTest('Controle de acesso DOT: concessão, revogação e auditoria', async () => {
  await reset();
  const empresa = crypto.randomUUID();

  // Sem responsável autenticado não é possível alterar permissões.
  await assert.rejects(
    () => setDotPermission(empresa, { resource: 'operations', action: 'execute', granted: true }),
    /Responsável autenticado é obrigatório/,
  );

  await setDotPermission(empresa, { resource: 'operations', action: 'execute', granted: true, grantedBy: 'user-1' });
  assert.equal(await dotAccessAllowed(empresa, 'operations', 'execute', 'user-1'), true);

  // Revogar remove o acesso efetivo.
  await setDotPermission(empresa, { resource: 'operations', action: 'execute', granted: false, grantedBy: 'user-1' });
  assert.equal(await dotAccessAllowed(empresa, 'operations', 'execute', 'user-1'), false);

  // Conceder de novo restaura.
  await setDotPermission(empresa, { resource: 'operations', action: 'execute', granted: true, grantedBy: 'user-2' });
  assert.equal(await dotAccessAllowed(empresa, 'operations', 'execute', 'user-2'), true);

  const list = await listDotPermissions(empresa);
  assert.equal(list.length, 1);
  assert.equal(Number(list[0].granted), 1);
  assert.equal(String(list[0].granted_by), 'user-2');

  // Toda tentativa (permitida ou negada) é auditada.
  const audit = await getDb().all('SELECT allowed, reason FROM dot_access_audit WHERE empresa_id = ? ORDER BY id ASC', [empresa]);
  assert.ok(audit.length >= 3);
  assert.ok(audit.some((row: { allowed: number }) => Number(row.allowed) === 0));
  assert.ok(audit.some((row: { allowed: number }) => Number(row.allowed) === 1));
  assert.ok(audit.some((row: { reason: string }) => row.reason === 'permission_revoked'));
});

accessTest('Controle de acesso DOT: permissão por usuário não vaza para o restante da empresa', async () => {
  await reset();
  const empresa = crypto.randomUUID();

  await setDotPermission(empresa, {
    resource: 'operations',
    action: 'execute',
    granted: true,
    userId: 'user-especifico',
    grantedBy: 'admin',
  });

  assert.equal(await dotAccessAllowed(empresa, 'operations', 'execute', 'user-especifico'), true);
  // Outro usuário da mesma empresa não recebe a permissão individual.
  assert.equal(await dotAccessAllowed(empresa, 'operations', 'execute', 'outro-usuario'), false);

  // Permissão da empresa inteira (userId nulo) alcança qualquer usuário.
  await setDotPermission(empresa, { resource: 'crm', action: 'read', granted: true, grantedBy: 'admin' });
  assert.equal(await dotAccessAllowed(empresa, 'crm', 'read', 'qualquer-usuario'), true);
  assert.equal(await dotAccessAllowed(empresa, 'crm', 'read', null), true);
});

accessTest('Controle de acesso DOT: revogação individual vence a concessão da empresa (e vice-versa)', async () => {
  await reset();
  const empresa = crypto.randomUUID();

  // A empresa inteira recebe a permissão; um usuário específico é revogado depois.
  await setDotPermission(empresa, { resource: 'operations', action: 'execute', granted: true, grantedBy: 'admin' });
  await setDotPermission(empresa, { resource: 'operations', action: 'execute', granted: false, userId: 'user-1', grantedBy: 'admin' });

  assert.equal(
    await dotAccessAllowed(empresa, 'operations', 'execute', 'user-1'),
    false,
    'revogação individual não pode ser sobreposta pela concessão da empresa',
  );
  assert.equal(await dotAccessAllowed(empresa, 'operations', 'execute', 'user-2'), true, 'os demais usuários seguem com a concessão da empresa');

  // O contrário também vale: revogação da empresa não derruba concessão individual.
  await setDotPermission(empresa, { resource: 'operations', action: 'execute', granted: false, grantedBy: 'admin' });
  await setDotPermission(empresa, { resource: 'operations', action: 'execute', granted: true, userId: 'user-2', grantedBy: 'admin' });

  assert.equal(await dotAccessAllowed(empresa, 'operations', 'execute', 'user-2'), true, 'concessão individual vence a revogação da empresa');
  assert.equal(await dotAccessAllowed(empresa, 'operations', 'execute', 'user-3'), false);
  assert.equal(await dotAccessAllowed(empresa, 'operations', 'execute', null), false);
});

accessTest('Controle de acesso DOT: baseline interno libera o núcleo, preserva revogações e não abre conectores externos', async () => {
  await reset();
  const empresa = crypto.randomUUID();

  // Revogação explícita feita ANTES do baseline não pode ser desfeita por ele.
  await setDotPermission(empresa, { resource: 'filtra', action: 'read', granted: false, grantedBy: 'admin' });

  await ensureDotInternalPermissionBaseline(empresa);

  // Núcleo interno (filtra/operations) liberado sem configuração manual.
  assert.equal(await dotAccessAllowed(empresa, 'filtra', 'analyze', null), true);
  assert.equal(await dotAccessAllowed(empresa, 'filtra', 'update', null), true);
  assert.equal(await dotAccessAllowed(empresa, 'operations', 'read', null), true);
  assert.equal(await dotAccessAllowed(empresa, 'operations', 'execute', null), true);

  // Revogação preservada (ON CONFLICT DO NOTHING).
  assert.equal(await dotAccessAllowed(empresa, 'filtra', 'read', null), false, 'baseline não pode reativar permissão revogada pelo cliente');

  // Nenhum conector externo é concedido pelo baseline.
  assert.equal(await dotAccessAllowed(empresa, 'crm', 'read', null), false);
  assert.equal(await dotAccessAllowed(empresa, 'email', 'external_send', null), false);
  assert.equal(await dotAccessAllowed(empresa, 'whatsapp', 'external_send', null), false);

  // Reexecução é idempotente e não reabre a revogação.
  await ensureDotInternalPermissionBaseline(empresa);
  assert.equal(await dotAccessAllowed(empresa, 'filtra', 'read', null), false);
});
