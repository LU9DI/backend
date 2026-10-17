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

const toolTest = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !sqliteAvailable }, fn);

import { initDB, getDb } from '../lib/db.js';
import { ensureDotAccessSchema, setDotPermission } from '../services/dotAccessControl.js';
import { invokeDotTool, listDotTools } from '../services/dotToolRegistry.js';

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = '/tmp/filtra-dot-tool-registry-test.sqlite';

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
  for (const table of ['dot_tool_audit', 'dot_agent_permissions', 'dot_access_audit', 'reviews', 'empresas']) {
    try {
      await db.run(`DELETE FROM ${table}`);
    } catch {
      /* tabela criada sob demanda */
    }
  }
}

async function seedEmpresa(empresaId: string) {
  const now = new Date().toISOString();
  await getDb().run(
    'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
    [empresaId, 'cnpj-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14), 'Empresa Ferramentas', 'slug-' + empresaId.slice(0, 8), 'ativo', 'rei', now, now],
  );
}

toolTest('Ferramentas do Dot: catálogo não expõe o executor', async () => {
  const tools = listDotTools();
  const ids = tools.map((tool) => tool.id).sort();
  assert.deepEqual(ids, ['company.workspace.read', 'dot.goals.read', 'reviews.analyze', 'reviews.read']);
  for (const tool of tools) {
    assert.equal(Object.prototype.hasOwnProperty.call(tool, 'execute'), false);
    assert.ok(tool.description.length > 0);
    assert.ok(['low', 'medium', 'high'].includes(tool.risk));
  }
});

toolTest('Ferramentas do Dot: invocação exige permissão explícita e é auditada', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  await seedEmpresa(empresa);

  // Sem permissão concedida, a ferramenta é recusada e a recusa é auditada.
  await assert.rejects(
    () => invokeDotTool({ empresaId: empresa, toolId: 'company.workspace.read', actorType: 'user', actorUserId: 'user-1' }),
    /DOT sem permissão/,
  );

  const denied = await getDb().get(
    'SELECT allowed, tool_id, actor_user_id FROM dot_tool_audit WHERE empresa_id = ? ORDER BY id DESC LIMIT 1',
    [empresa],
  );
  assert.equal(Number(denied?.allowed), 0);
  assert.equal(String(denied?.tool_id), 'company.workspace.read');
  assert.equal(String(denied?.actor_user_id), 'user-1');

  // Com permissão explícita, executa e registra o resultado.
  await setDotPermission(empresa, { resource: 'filtra', action: 'read', granted: true, grantedBy: 'user-1' });
  const allowed = await invokeDotTool({ empresaId: empresa, toolId: 'company.workspace.read', actorType: 'user', actorUserId: 'user-1' });
  assert.equal(allowed.ok, true);
  assert.equal((allowed.result as { empresa: { id: string } }).empresa.id, empresa);

  const audit = await getDb().get(
    'SELECT allowed, result_json FROM dot_tool_audit WHERE empresa_id = ? AND allowed = 1 ORDER BY id DESC LIMIT 1',
    [empresa],
  );
  assert.equal(Number(audit?.allowed), 1);
  assert.match(String(audit?.result_json), /Empresa Ferramentas/);
});

toolTest('Ferramentas do Dot: ferramenta desconhecida e limite de leitura', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  await seedEmpresa(empresa);
  await setDotPermission(empresa, { resource: 'filtra', action: 'read', granted: true, grantedBy: 'user-1' });

  await assert.rejects(
    () => invokeDotTool({ empresaId: empresa, toolId: 'ferramenta.inexistente', actorType: 'user' }),
    /não registrada/,
  );

  for (let i = 0; i < 3; i += 1) {
    await getDb().run(
      'INSERT INTO reviews (empresa_id,name,rating,comment,ai_tags,createdAt) VALUES (?,?,?,?,?,?)',
      [empresa, 'Cliente ' + i, 5, 'Ótimo atendimento', JSON.stringify(['atendimento']), new Date().toISOString()],
    );
  }

  const limited = await invokeDotTool({ empresaId: empresa, toolId: 'reviews.read', actorType: 'user', input: { limit: 5000 } });
  const rows = limited.result as Array<{ id: number }>;
  assert.equal(rows.length, 3);

  // O tenant da ferramenta é sempre o da empresa informada.
  const outra = crypto.randomUUID();
  await seedEmpresa(outra);
  await setDotPermission(outra, { resource: 'filtra', action: 'read', granted: true, grantedBy: 'user-2' });
  const otherRows = await invokeDotTool({ empresaId: outra, toolId: 'reviews.read', actorType: 'user', input: { limit: 10 } });
  assert.equal((otherRows.result as Array<unknown>).length, 0);
});
