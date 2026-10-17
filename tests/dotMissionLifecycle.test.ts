/**
 * Ciclo de vida da missão do agente Dot — correções A1/M4.
 *
 * Cobre os cenários que a auditoria apontou como quebrados:
 *  - ciclo completo: aprovar → executar a ação → retomar → concluir;
 *  - aprovar não executa (a ação continua apenas aprovada);
 *  - executar sem aprovação é recusado e a barreira não é atravessada;
 *  - ação/etapa repetida não duplica trabalho;
 *  - falha repetida pausa e a retomada explícita volta sem apagar o histórico;
 *  - etapa de aprovação sem ação preparada é passagem, não bloqueio;
 *  - nenhuma operação cruza empresas;
 *  - chamadas concorrentes na mesma missão não duplicam etapas nem ações;
 *  - cada output fica registrado na etapa correta (sem deslocamento).
 */
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

const lifecycleTest = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !sqliteAvailable }, fn);

import { getDb, initDB } from '../lib/db.js';
import { ensureDotAccessSchema } from '../services/dotAccessControl.js';
import { createDotAgentGoal, ensureDotAgentSchema } from '../services/dotAgent.js';
import {
  createMissionForGoal,
  ensureMissionTables,
  listDotAgentMissionSteps,
  listDotAgentMissions,
} from '../services/dotAgentMissions.js';
import {
  advanceMissionManually,
  resumeMissionAfterApprovedExecution,
  resumePausedMission,
  runCurrentDotMissionStep,
} from '../services/dotAgentMissionRunner.js';
import { approveDotAction, executeDotAction, listDotActions } from '../services/dotActionQueue.js';

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = '/tmp/filtra-dot-mission-lifecycle-test.sqlite';

let ready = false;

async function setup() {
  if (ready) return;
  await initDB();
  await ensureDotAccessSchema();
  await ensureDotAgentSchema();
  await ensureMissionTables();
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
    'dot_followups',
    'dot_agent_permissions',
    'dot_access_audit',
    'reviews',
    'empresas',
  ]) {
    try {
      await db.run(`DELETE FROM ${table}`);
    } catch {
      /* tabela criada sob demanda pelo serviço correspondente */
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

async function grantPermission(empresaId: string, resource: string, action: string) {
  const now = new Date().toISOString();
  await getDb().run(
    'INSERT INTO dot_agent_permissions (empresa_id,user_id,resource,action,granted,granted_by,granted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [empresaId, null, resource, action, 1, 'teste', now, now, now],
  );
}

/** Avança observe → investigate → recommend → prepare e devolve a missão na barreira. */
async function advanceToApproval(empresa: string) {
  const goal = await createDotAgentGoal(empresa, { title: 'Reduzir reclamações sobre tempo de espera' });
  const mission = await createMissionForGoal(empresa, goal.id, goal.title);
  assert.ok(mission);
  for (const expected of [/Contexto observado/, /Investigação do objetivo/, /Recomendação registrada/, /preparada/]) {
    const step = await runCurrentDotMissionStep(empresa, mission.id);
    assert.ok(step && !step.blocked, `etapa esperada falhou: ${expected}`);
    assert.match(String(step.output), expected);
  }
  const row = await getDb().get(
    'SELECT approval_action_id, status, current_step FROM dot_agent_missions WHERE id = ? AND empresa_id = ?',
    [mission.id, empresa],
  );
  return {
    mission,
    actionId: Number(row?.approval_action_id),
    status: String(row?.status),
    currentStep: Number(row?.current_step),
  };
}

lifecycleTest('Dot missão: ciclo completo aprova, executa e conclui com output na etapa certa', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  await seedEmpresa(empresa);
  await seedReviews(empresa, [2, 2, 3, 2, 2, 2]);
  await grantPermission(empresa, 'operations', 'execute');

  const { mission, actionId, status, currentStep } = await advanceToApproval(empresa);
  assert.ok(actionId > 0, 'a etapa prepare deve vincular a ação preparada');
  assert.equal(status, 'waiting_approval');
  assert.equal(currentStep, 4, 'a etapa atual deve ser a barreira de aprovação');

  // M4: cada output pertence à própria etapa, sem deslocamento de uma etapa.
  const steps = await listDotAgentMissionSteps(empresa, mission.id);
  assert.deepEqual(steps.map((step: any) => step.type), ['observe', 'investigate', 'recommend', 'prepare', 'approval', 'result']);
  assert.match(String(steps[0].output), /Contexto observado/);
  assert.match(String(steps[1].output), /Investigação do objetivo/);
  assert.match(String(steps[2].output), /Recomendação registrada/);
  assert.match(String(steps[3].output), /preparada/);
  assert.equal(steps[4].output, null, 'a etapa de aprovação ainda não foi executada');
  assert.equal(steps[5].output, null);

  // Executar antes de aprovar é recusado pelo gateway.
  const notApproved = await executeDotAction(empresa, actionId, 'usuario-teste');
  assert.equal(notApproved.ok, false);

  // Aprovação explícita — não executa nada.
  const approved = await approveDotAction(empresa, actionId);
  assert.equal(approved?.status, 'approved');

  // Execução real pelo gateway (executor interno).
  const executed = await executeDotAction(empresa, actionId, 'usuario-teste');
  assert.equal(executed.ok, true, executed.reason);
  assert.equal(executed.status, 'executed');

  // Executar a ação aprovada retoma a missão: aprovação → resultado → conclusão.
  const resumed = await resumeMissionAfterApprovedExecution(empresa, actionId, `Ação executada pelo gateway: ${executed.reason}`);
  assert.equal(resumed?.status, 'completed');

  const after = await listDotAgentMissionSteps(empresa, mission.id);
  assert.match(String(after[4].output), /Ação executada pelo gateway/);
  assert.match(String(after[5].output), /Resultado da ação/);
  assert.match(String(after[5].output), /"executed"/);

  const action = await getDb().get('SELECT status FROM dot_action_queue WHERE id = ? AND empresa_id = ?', [actionId, empresa]);
  assert.equal(String(action?.status), 'executed');

  // Repetir a retomada não altera nada: a missão já saiu de waiting_approval.
  assert.equal(await resumeMissionAfterApprovedExecution(empresa, actionId), null);
});

lifecycleTest('Dot missão: aprovação sem execução conclui o fluxo sem executar a ação', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  await seedEmpresa(empresa);
  await seedReviews(empresa, [2, 2, 3, 2, 2, 2]);
  const { mission, actionId } = await advanceToApproval(empresa);

  const approved = await approveDotAction(empresa, actionId);
  assert.equal(approved?.status, 'approved');

  // A listagem expõe a ação vinculada com o status real (a UI usa isso).
  const listed = await listDotAgentMissions(empresa);
  const current = listed.find((item: any) => Number(item.id) === Number(mission.id));
  assert.ok(current);
  assert.equal(String(current?.status), 'waiting_approval');
  assert.equal(Number(current?.approval_action?.id), actionId);
  assert.equal(String(current?.approval_action?.status), 'approved');

  // O runner registra o status e segue; não executa a ação.
  let step = await runCurrentDotMissionStep(empresa, mission.id);
  assert.ok(step && !step.blocked);
  assert.match(String(step.output), /approved/);
  step = await runCurrentDotMissionStep(empresa, mission.id);
  assert.ok(step && !step.blocked);
  assert.equal(step.mission?.status, 'completed');

  const action = await getDb().get('SELECT status, executed_at FROM dot_action_queue WHERE id = ? AND empresa_id = ?', [actionId, empresa]);
  assert.equal(String(action?.status), 'approved');
  assert.equal(action?.executed_at, null);
});

lifecycleTest('Dot missão: execução não aprovada e avanço direto não atravessam a barreira', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  await seedEmpresa(empresa);
  await seedReviews(empresa, [2, 2, 3, 2, 2, 2]);
  await grantPermission(empresa, 'operations', 'execute');
  const { mission, actionId } = await advanceToApproval(empresa);

  const notApproved = await executeDotAction(empresa, actionId, 'usuario-teste');
  assert.equal(notApproved.ok, false);

  // Avanço manual direto respeita a mesma barreira.
  await assert.rejects(() => advanceMissionManually(empresa, mission.id), /Aprovação explícita é obrigatória/);

  // E o runner bloqueia a etapa de aprovação.
  const blocked = await runCurrentDotMissionStep(empresa, mission.id);
  assert.equal(blocked?.blocked, true);
  assert.match(String(blocked?.reason), /aprovação explícita/i);

  const row = await getDb().get('SELECT status, current_step FROM dot_agent_missions WHERE id = ? AND empresa_id = ?', [mission.id, empresa]);
  assert.equal(String(row?.status), 'waiting_approval');
  assert.equal(Number(row?.current_step), 4);
});

lifecycleTest('Dot missão: etapa de aprovação sem ação preparada é passagem e não pausa a missão', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  await seedEmpresa(empresa);
  // Sem avaliações: o monitor não encontra sinal e nenhuma ação é preparada.
  const goal = await createDotAgentGoal(empresa, { title: 'Organizar o atendimento sem sinais novos' });
  const mission = await createMissionForGoal(empresa, goal.id, goal.title);
  assert.ok(mission);

  for (let i = 0; i < 3; i += 1) {
    const step = await runCurrentDotMissionStep(empresa, mission.id);
    assert.ok(step && !step.blocked);
  }
  const prepare = await runCurrentDotMissionStep(empresa, mission.id);
  assert.ok(prepare && !prepare.blocked);
  assert.match(String(prepare.output), /Nenhuma ação foi preparada/);

  const row = await getDb().get('SELECT approval_action_id, status FROM dot_agent_missions WHERE id = ? AND empresa_id = ?', [mission.id, empresa]);
  assert.equal(row?.approval_action_id, null);
  assert.equal(String(row?.status), 'waiting_approval');

  const approval = await runCurrentDotMissionStep(empresa, mission.id);
  assert.ok(approval && !approval.blocked);
  assert.match(String(approval.output), /Nenhuma ação pendente/);

  const result = await runCurrentDotMissionStep(empresa, mission.id);
  assert.ok(result && !result.blocked);
  assert.match(String(result.output), /sem execução externa/);
  assert.equal(result.mission?.status, 'completed');
  assert.equal((await listDotActions(empresa)).length, 0);
});

lifecycleTest('Dot missão: falha repetida pausa; retomada explícita volta sem apagar o histórico', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  await seedEmpresa(empresa);
  const goal = await createDotAgentGoal(empresa, { title: 'Objetivo com falha controlada' });
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

  // Avançar direto numa missão pausada não é permitido.
  await assert.rejects(() => advanceMissionManually(empresa, mission.id), /pausada/i);

  // O histórico da falha permanece visível até uma execução bem-sucedida.
  let steps = await listDotAgentMissionSteps(empresa, mission.id);
  assert.match(String(steps[0].output), /Falha ao executar a etapa \(tentativa 3\)/);

  const resumed = await resumePausedMission(empresa, mission.id);
  assert.equal(resumed?.resumed, true);
  assert.equal(resumed?.mission?.status, 'working');

  steps = await listDotAgentMissionSteps(empresa, mission.id);
  assert.match(String(steps[0].output), /Falha ao executar a etapa \(tentativa 3\)/, 'retomar não apaga o histórico nem reexecuta a etapa');

  // Com a empresa de volta, a etapa executa e a missão segue.
  await seedEmpresa(empresa);
  const step = await runCurrentDotMissionStep(empresa, mission.id);
  assert.ok(step && !step.blocked);
  assert.match(String(step.output), /Contexto observado/);
  assert.equal(Number(step.mission?.current_step), 1);

  // Retomada de missão que não está pausada é recusada com motivo.
  const notPaused = await resumePausedMission(empresa, mission.id);
  assert.equal(notPaused?.resumed, false);
  assert.match(String(notPaused?.reason), /não está pausada/);
});

lifecycleTest('Dot missão: nenhuma operação cruza empresas', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  const outra = crypto.randomUUID();
  await seedEmpresa(empresa);
  await seedEmpresa(outra);
  await seedReviews(empresa, [2, 2, 3, 2, 2, 2]);
  const { mission, actionId } = await advanceToApproval(empresa);

  assert.equal(await runCurrentDotMissionStep(outra, mission.id), null);
  assert.equal(await advanceMissionManually(outra, mission.id), null);
  assert.equal(await resumePausedMission(outra, mission.id), null);
  assert.equal(await resumeMissionAfterApprovedExecution(outra, actionId), null);
  assert.equal((await listDotAgentMissions(outra)).length, 0);

  // A empresa dona continua funcionando.
  assert.equal((await listDotAgentMissions(empresa)).length, 1);
  assert.equal((await listDotAgentMissionSteps(empresa, mission.id)).length, 6);
});

lifecycleTest('Dot missão: chamadas concorrentes não duplicam etapas nem ações', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  await seedEmpresa(empresa);
  await seedReviews(empresa, [2, 2, 3, 2, 2, 2]);
  const goal = await createDotAgentGoal(empresa, { title: 'Concorrência controlada na missão' });
  const mission = await createMissionForGoal(empresa, goal.id, goal.title);
  assert.ok(mission);

  // Três chamadas simultâneas: cada etapa roda no máximo uma vez.
  const first = await Promise.all([
    runCurrentDotMissionStep(empresa, mission.id),
    runCurrentDotMissionStep(empresa, mission.id),
    runCurrentDotMissionStep(empresa, mission.id),
  ]);
  for (const result of first) assert.ok(result && !result.blocked);

  let row = await getDb().get('SELECT current_step, status FROM dot_agent_missions WHERE id = ? AND empresa_id = ?', [mission.id, empresa]);
  assert.equal(Number(row?.current_step), 3, 'três chamadas executam exatamente três etapas');

  // Na etapa prepare, chamadas simultâneas criam uma única ação vinculada e um
  // único conjunto de eventos/decisões.
  const second = await Promise.all([
    runCurrentDotMissionStep(empresa, mission.id),
    runCurrentDotMissionStep(empresa, mission.id),
  ]);
  assert.ok(second[0] && !second[0].blocked);
  assert.equal(second[1]?.blocked, true, 'a segunda chamada encontra a barreira de aprovação, não a etapa prepare');

  const db = getDb();
  const countActions = Number(
    (await db.get('SELECT COUNT(*) AS total FROM dot_action_queue WHERE empresa_id = ?', [empresa]))?.total,
  );
  assert.ok(countActions >= 1, 'a preparação deve criar a ação vinculada à missão');
  const events = await db.all('SELECT id FROM dot_events WHERE empresa_id = ?', [empresa]);
  assert.equal(events.length, 2, 'os eventos não são duplicados por chamadas simultâneas');
  const decisions = await db.all('SELECT id FROM dot_decisions WHERE empresa_id = ?', [empresa]);
  assert.equal(decisions.length, 2);

  row = await getDb().get('SELECT current_step, status, approval_action_id FROM dot_agent_missions WHERE id = ? AND empresa_id = ?', [mission.id, empresa]);
  assert.equal(Number(row?.current_step), 4);
  assert.equal(String(row?.status), 'waiting_approval');
  assert.ok(Number(row?.approval_action_id) > 0);

  // Repetição concorrente na barreira não cria trabalho novo.
  const third = await Promise.all([
    runCurrentDotMissionStep(empresa, mission.id),
    runCurrentDotMissionStep(empresa, mission.id),
  ]);
  for (const result of third) assert.equal(result?.blocked, true);
  const countAfter = Number(
    (await db.get('SELECT COUNT(*) AS total FROM dot_action_queue WHERE empresa_id = ?', [empresa]))?.total,
  );
  assert.equal(countAfter, countActions, 'chamadas repetidas na barreira não duplicam ações');
});
