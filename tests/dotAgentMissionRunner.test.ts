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

const runnerTest = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !sqliteAvailable }, fn);

import { initDB, getDb } from '../lib/db.js';
import { ensureDotAccessSchema } from '../services/dotAccessControl.js';
import { createDotAgentGoal, ensureDotAgentSchema } from '../services/dotAgent.js';
import {
  createMissionForGoal,
  ensureMissionTables,
  listDotAgentMissionSteps,
} from '../services/dotAgentMissions.js';
import { runCurrentDotMissionStep } from '../services/dotAgentMissionRunner.js';
import { approveDotAction } from '../services/dotActionQueue.js';

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = '/tmp/filtra-dot-mission-runner-test.sqlite';

let ready = false;

async function setup() {
  if (ready) return;
  await initDB();
  await ensureDotAccessSchema();
  await ensureDotAgentSchema();
  await ensureMissionTables();
  const columns = await getDb().all('PRAGMA table_info(reviews)');
  if (!(columns || []).some((column: { name?: string }) => column.name === 'is_test')) {
    throw new Error('initDB deve garantir reviews.is_test (correção A2)');
  }
  ready = true;
}

async function reset() {
  await setup();
  const db = getDb();
  for (const table of [
    'dot_agent_mission_steps',
    'dot_agent_missions',
    'dot_agent_goals',
    'dot_events',
    'dot_decisions',
    'dot_action_queue',
    'dot_internal_cases',
    'dot_agent_permissions',
    'reviews',
    'empresas',
  ]) {
    // Algumas tabelas são criadas sob demanda pelo serviço correspondente;
    // a limpeza precisa tolerar a ausência antes do primeiro uso.
    try {
      await db.run(`DELETE FROM ${table}`);
    } catch {
      /* tabela ainda não existe neste banco de teste */
    }
  }
}

async function seedEmpresa(empresaId: string, plan = 'rei') {
  const now = new Date().toISOString();
  await getDb().run(
    'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
    [empresaId, 'cnpj-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14), 'Empresa ' + empresaId.slice(0, 6), 'slug-' + empresaId.slice(0, 8), 'ativo', plan, now, now],
  );
}

async function seedReviews(empresaId: string, ratings: number[]) {
  const db = getDb();
  for (const rating of ratings) {
    await db.run(
      'INSERT INTO reviews (empresa_id,name,rating,comment,ai_tags,is_test,createdAt) VALUES (?,?,?,?,?,0,?)',
      [empresaId, 'Cliente', rating, 'Demora no atendimento e tempo de espera longo', JSON.stringify(['tempo de espera']), new Date().toISOString()],
    );
  }
}

async function grantExecutePermission(empresaId: string) {
  const now = new Date().toISOString();
  await getDb().run(
    'INSERT INTO dot_agent_permissions (empresa_id,user_id,resource,action,granted,granted_by,granted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [empresaId, null, 'operations', 'execute', 1, 'teste', now, now, now],
  );
}

runnerTest('Dot mission runner: ciclo completo com barreira de aprovação', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  await seedEmpresa(empresa);
  await seedReviews(empresa, [2, 2, 3, 2, 2, 2]);

  const goal = await createDotAgentGoal(empresa, { title: 'Reduzir reclamações sobre tempo de espera' });
  const mission = await createMissionForGoal(empresa, goal.id, goal.title);
  assert.ok(mission);
  assert.equal(mission?.status, 'planned');

  const steps = await listDotAgentMissionSteps(empresa, mission.id);
  assert.equal(steps.length, 6);
  assert.deepEqual(steps.map((step: { type: string }) => step.type), ['observe', 'investigate', 'recommend', 'prepare', 'approval', 'result']);

  // observe
  let step = await runCurrentDotMissionStep(empresa, mission.id);
  assert.ok(step && !step.blocked);
  assert.match(String(step.output), /Contexto observado/);

  // investigate
  step = await runCurrentDotMissionStep(empresa, mission.id);
  assert.ok(step && !step.blocked);
  assert.match(String(step.output), /Investigação do objetivo/);

  // recommend
  step = await runCurrentDotMissionStep(empresa, mission.id);
  assert.ok(step && !step.blocked);
  assert.match(String(step.output), /Recomendação registrada/);

  // prepare: cria uma ação real e vincula à missão
  step = await runCurrentDotMissionStep(empresa, mission.id);
  assert.ok(step && !step.blocked);
  assert.match(String(step.output), /preparada/);

  const db = getDb();
  const missionRow = await db.get(
    'SELECT approval_action_id, current_step, status FROM dot_agent_missions WHERE id = ? AND empresa_id = ?',
    [mission.id, empresa],
  );
  const actionId = Number(missionRow?.approval_action_id);
  assert.ok(actionId > 0, 'a etapa prepare deve vincular uma ação preparada');

  // approval: bloqueia enquanto não houver aprovação explícita
  step = await runCurrentDotMissionStep(empresa, mission.id);
  assert.equal(step?.blocked, true);
  assert.match(String(step?.reason), /aprovação explícita/i);

  // Idempotência: repetir a chamada não avança nem duplica a etapa.
  const repeat = await runCurrentDotMissionStep(empresa, mission.id);
  assert.equal(repeat?.blocked, true);
  const afterRepeat = await db.get('SELECT current_step FROM dot_agent_missions WHERE id = ? AND empresa_id = ?', [mission.id, empresa]);
  assert.equal(Number(afterRepeat?.current_step), Number(missionRow?.current_step));

  // Aprovação explícita (separada da execução).
  const approved = await approveDotAction(empresa, actionId);
  assert.equal(approved?.status, 'approved');

  // approval: agora avança
  step = await runCurrentDotMissionStep(empresa, mission.id);
  assert.ok(step && !step.blocked);
  assert.match(String(step.output), /approved/);

  // result: registra o resultado sem executar a ação
  step = await runCurrentDotMissionStep(empresa, mission.id);
  assert.ok(step && !step.blocked);
  assert.match(String(step.output), /Resultado da ação/);
  assert.equal(step.mission?.status, 'completed');

  // A ação permanece apenas aprovada: aprovar não executa.
  const action = await db.get('SELECT status FROM dot_action_queue WHERE id = ? AND empresa_id = ?', [actionId, empresa]);
  assert.equal(String(action?.status), 'approved');

  // Missão concluída não aceita mais execução de etapa.
  const finished = await runCurrentDotMissionStep(empresa, mission.id);
  assert.equal(finished?.blocked, true);
  assert.match(String(finished?.reason), /concluída/i);
});

runnerTest('Dot mission runner: falha repetida pausa a missão em vez de repetir para sempre', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  await seedEmpresa(empresa);

  const goal = await createDotAgentGoal(empresa, { title: 'Objetivo para forçar falha controlada' });
  const mission = await createMissionForGoal(empresa, goal.id, goal.title);
  assert.ok(mission);

  // Sem a empresa, a etapa observe falha de forma determinística.
  await getDb().run('DELETE FROM empresas WHERE id = ?', [empresa]);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const step = await runCurrentDotMissionStep(empresa, mission.id);
    assert.equal(step?.blocked, true);
    assert.match(String(step?.reason), /falha/i);
  }

  const row = await getDb().get('SELECT status FROM dot_agent_missions WHERE id = ? AND empresa_id = ?', [mission.id, empresa]);
  assert.equal(String(row?.status), 'paused');

  const afterPause = await runCurrentDotMissionStep(empresa, mission.id);
  assert.equal(afterPause?.blocked, true);
  assert.match(String(afterPause?.reason), /pausada/i);
});

runnerTest('Dot mission runner: missão de outra empresa não é acessível', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  const outra = crypto.randomUUID();
  await seedEmpresa(empresa);
  await seedEmpresa(outra);

  const goal = await createDotAgentGoal(empresa, { title: 'Objetivo isolado por empresa' });
  const mission = await createMissionForGoal(empresa, goal.id, goal.title);
  assert.ok(mission);

  assert.equal(await runCurrentDotMissionStep(outra, mission.id), null);

  // E o mesmo vale para criar missão a partir de objetivo de outra empresa.
  const goalOutra = await createDotAgentGoal(outra, { title: 'Objetivo da outra empresa' });
  assert.equal(await createMissionForGoal(empresa, goalOutra.id, goalOutra.title), null);
});

runnerTest('Dot mission runner: prepare não cria ação duplicada quando repetido', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  await seedEmpresa(empresa);
  await seedReviews(empresa, [1, 2, 2, 1, 2, 1]);
  await grantExecutePermission(empresa);

  const goal = await createDotAgentGoal(empresa, { title: 'Investigar queda de nota recorrente' });
  const mission = await createMissionForGoal(empresa, goal.id, goal.title);
  assert.ok(mission);

  // Avança até a etapa prepare.
  for (let i = 0; i < 3; i += 1) {
    await runCurrentDotMissionStep(empresa, mission.id);
  }
  const prepared = await runCurrentDotMissionStep(empresa, mission.id);
  assert.ok(prepared && !prepared.blocked);

  const db = getDb();
  const first = await db.get('SELECT approval_action_id FROM dot_agent_missions WHERE id = ? AND empresa_id = ?', [mission.id, empresa]);
  const actionId = Number(first?.approval_action_id);
  assert.ok(actionId > 0);

  const countAfterFirstPrepare = Number(
    (await db.get('SELECT COUNT(*) AS total FROM dot_action_queue WHERE empresa_id = ?', [empresa]))?.total,
  );
  assert.ok(countAfterFirstPrepare >= 1);

  // Reexecutar a etapa prepare (simulando recuperação) não cria outra ação.
  const missionRow = await db.get('SELECT current_step FROM dot_agent_missions WHERE id = ? AND empresa_id = ?', [mission.id, empresa]);
  await db.run('UPDATE dot_agent_missions SET current_step = ? WHERE id = ? AND empresa_id = ?', [Number(missionRow?.current_step) - 1, mission.id, empresa]);
  const repeated = await runCurrentDotMissionStep(empresa, mission.id);
  assert.ok(repeated && !repeated.blocked);

  const second = await db.get('SELECT approval_action_id FROM dot_agent_missions WHERE id = ? AND empresa_id = ?', [mission.id, empresa]);
  assert.equal(Number(second?.approval_action_id), actionId);

  const countAfterRepeat = Number(
    (await db.get('SELECT COUNT(*) AS total FROM dot_action_queue WHERE empresa_id = ?', [empresa]))?.total,
  );
  assert.equal(countAfterRepeat, countAfterFirstPrepare);
});
