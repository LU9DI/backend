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

const goalsTest = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !sqliteAvailable }, fn);

import { initDB, getDb } from '../lib/db.js';
import {
  createDotAgentGoal,
  ensureDotAgentSchema,
  getDotAgentWorkspace,
  listDotAgentGoals,
  updateDotAgentGoal,
} from '../services/dotAgent.js';

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = '/tmp/filtra-dot-agent-goals-test.sqlite';

let ready = false;

async function setup() {
  if (ready) return;
  await initDB();
  await ensureDotAgentSchema();
  ready = true;
}

async function reset() {
  await setup();
  await getDb().run('DELETE FROM dot_agent_goals');
}

goalsTest('Dot goals: criação, validação e isolamento entre empresas', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  const outra = crypto.randomUUID();

  const goal = await createDotAgentGoal(empresa, {
    title: 'Reduzir reclamações sobre tempo de espera',
    source: 'teste_regressao',
  });
  assert.ok(goal.id > 0);
  assert.equal(goal.status, 'active');
  assert.equal(goal.progress, 0);
  assert.equal(goal.source, 'teste_regressao');
  assert.ok(goal.last_activity_at);

  const list = await listDotAgentGoals(empresa);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, goal.id);

  // Isolamento: outra empresa não enxerga nem altera o objetivo.
  assert.equal((await listDotAgentGoals(outra)).length, 0);
  assert.equal(await updateDotAgentGoal(outra, goal.id, { status: 'completed' }), null);

  // Validações reais de entrada.
  await assert.rejects(() => createDotAgentGoal(empresa, { title: 'ab' }), /3 e 180/);
  await assert.rejects(() => createDotAgentGoal(empresa, { title: 'x'.repeat(200) }), /3 e 180/);
  await assert.rejects(
    () => createDotAgentGoal(empresa, { title: 'Objetivo válido', description: 'y'.repeat(2100) }),
    /2000/,
  );
  await assert.rejects(() => updateDotAgentGoal(empresa, goal.id, { status: 'inventado' }), /Status de objetivo inválido/);
  await assert.rejects(() => updateDotAgentGoal(empresa, goal.id, { progress: 140 }), /entre 0 e 100/);
  await assert.rejects(() => createDotAgentGoal('', { title: 'Objetivo sem empresa' }), /Empresa é obrigatória/);
});

goalsTest('Dot goals: atualização de status/progresso e workspace', async () => {
  await reset();
  const empresa = crypto.randomUUID();

  const ativo = await createDotAgentGoal(empresa, { title: 'Objetivo ativo recente' });
  const pausado = await createDotAgentGoal(empresa, { title: 'Objetivo a pausar' });
  const concluido = await createDotAgentGoal(empresa, { title: 'Objetivo a concluir' });

  assert.equal((await updateDotAgentGoal(empresa, pausado.id, { status: 'paused' }))?.status, 'paused');
  assert.equal((await updateDotAgentGoal(empresa, concluido.id, { status: 'completed', progress: 100 }))?.progress, 100);

  const workspace = await getDotAgentWorkspace(empresa);
  assert.equal(workspace.summary.active, 1);
  assert.equal(workspace.summary.attention, 0);
  assert.equal(workspace.goals.length, 3);

  // Arquivar remove o objetivo do workspace (mas não o apaga do banco).
  await updateDotAgentGoal(empresa, concluido.id, { status: 'archived' });
  const afterArchive = await getDotAgentWorkspace(empresa);
  assert.equal(afterArchive.goals.length, 2);
  assert.equal(afterArchive.summary.active, 1);

  // Objetivo ativo sem atividade recente conta como atenção.
  const antigo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await getDb().run('UPDATE dot_agent_goals SET last_activity_at = ? WHERE id = ? AND empresa_id = ?', [antigo, ativo.id, empresa]);
  const stale = await getDotAgentWorkspace(empresa);
  assert.equal(stale.summary.active, 1);
  assert.equal(stale.summary.attention, 1);
});
