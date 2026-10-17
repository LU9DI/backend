/**
 * M3 + A1 (HTTP) — precedência das rotas de decisão/ação e o fluxo real
 * aprovar → executar → retomar a missão pela API.
 *
 * M3: `POST /api/dot/decisions/:id/prepare-action` precisa ser alcançado (a
 * rota genérica `/:id/:action` não pode capturá-lo). A aprovação continua
 * exclusivamente na fila de ações.
 *
 * A1: pela API, aprovar não executa; executar exige aprovação prévia; executar
 * a ação vinculada retoma a missão que aguardava aprovação e a conclui.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDb = path.join(os.tmpdir(), `filtra-dot-routing-${Date.now()}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.DOT_AGENT_WORKER_ENABLED = '0';
delete process.env.DOT_DEMO_MODE;

let server: any;
let baseUrl = '';
let getDb: any;
let signAccessToken: (payload: any) => string;
const empresaId = crypto.randomUUID();
const outraEmpresaId = crypto.randomUUID();

function tokenFor(empresa: string) {
  return signAccessToken({
    id: `user-${empresa.slice(0, 8)}`,
    nome_funcionario: 'Responsável Teste',
    empresa_id: empresa,
    role: 'empresa',
  });
}

async function api(method: string, pathName: string, body?: unknown, empresa = empresaId) {
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(empresa)}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function grantPermission(empresa: string, resource: string, action: string) {
  const now = new Date().toISOString();
  await getDb().run(
    'INSERT INTO dot_agent_permissions (empresa_id,user_id,resource,action,granted,granted_by,granted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [empresa, null, resource, action, 1, 'teste', now, now, now],
  );
}

async function seedEmpresa(id: string, plan = 'rei') {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 30 * 86400000).toISOString();
  await getDb().run(
    'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
    [id, 'cnpj-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14), 'Empresa Routing', 'slug-' + id.slice(0, 8), 'ativo', plan, now, future],
  );
}

async function seedDecision(empresa: string) {
  const db = getDb();
  const options = [
    { id: 'opcao_1', title: 'Resolver diretamente', description: 'Priorizar a pendência.', action: 'priorizar_e_resolver', risk: 'medio' },
    { id: 'opcao_2', title: 'Escalar para responsável', description: 'Encaminhar com contexto.', action: 'escalar_responsavel', risk: 'baixo' },
  ];
  const result = await db.run(
    'INSERT INTO dot_decisions (empresa_id,event_id,type,priority,severity,reason,evidence_json,recommendation,options_json,requires_approval,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [empresa, 1, 'monitoramento', 'alta', 'warning', 'Tema recorrente', JSON.stringify(['evidência']), 'Recomendação', JSON.stringify(options), 1, 'pending', new Date().toISOString()],
  );
  return Number(result?.lastID);
}

before(async () => {
  const { default: express } = await import('express');
  const cookieParser = (await import('cookie-parser')).default;
  const { initDB, getDb: db } = await import('../lib/db.js');
  const { signAccessToken: sign } = await import('../lib/auth.js');
  const { mountDotRoutes } = await import('../routes/dotRoutes.js');
  const { mountDotAgentRoutes } = await import('../routes/dotAgentRoutes.js');
  const { mountDotAgentMissionRoutes } = await import('../routes/dotAgentMissionRoutes.js');
  const { ensureDotAccessSchema } = await import('../services/dotAccessControl.js');
  const { ensureDotAgentSchema } = await import('../services/dotAgent.js');
  const { ensureMissionTables, listDotAgentMissions } = await import('../services/dotAgentMissions.js');
  const { listDotDecisions } = await import('../services/dotDecision.js');
  const { listDotActions } = await import('../services/dotActionQueue.js');

  await initDB();
  await ensureDotAccessSchema();
  await ensureDotAgentSchema();
  await ensureMissionTables();
  signAccessToken = sign;
  getDb = db;

  const e = express();
  e.use(cookieParser());
  e.use(express.json({ limit: '20kb' }));
  mountDotRoutes(e);
  mountDotAgentRoutes(e);
  mountDotAgentMissionRoutes(e);

  await new Promise<void>((resolve) => {
    server = e.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  await seedEmpresa(empresaId);
  await seedEmpresa(outraEmpresaId);
  for (const [resource, action] of [
    ['filtra', 'create'],
    ['filtra', 'update'],
    ['filtra', 'execute'],
    ['operations', 'create'],
    ['operations', 'execute'],
  ] as const) {
    await grantPermission(empresaId, resource, action);
  }
  await grantPermission(outraEmpresaId, 'filtra', 'create');

  // Bootstrap do schema de decisões/fila e seed de avaliações reais.
  await listDotDecisions(empresaId);
  await listDotActions(empresaId);
  for (let i = 0; i < 6; i += 1) {
    await getDb().run(
      'INSERT INTO reviews (empresa_id,name,rating,comment,ai_tags,is_test,createdAt) VALUES (?,?,?,?,?,0,?)',
      [empresaId, 'Cliente', 2, 'Demora no atendimento e tempo de espera longo', JSON.stringify(['tempo de espera']), new Date().toISOString()],
    );
  }

  // Sanidade do harness: nada pendente antes dos testes.
  assert.deepEqual(await listDotAgentMissions(empresaId), []);
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    fs.unlinkSync(tmpDb);
  } catch {
    /* ok */
  }
});

describe('M3: precedência de /decisions/:id/prepare-action', () => {
  it('prepare-action é alcançado e prepara a ação (não cai na rota genérica)', async () => {
    const decisionId = await seedDecision(empresaId);
    assert.ok(decisionId > 0);

    const res = await api('POST', `/api/dot/decisions/${decisionId}/prepare-action`, { optionId: 'opcao_1' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.ok, true);
    assert.equal(res.data.action?.status, 'prepared');
    assert.equal(res.data.executed, false);
  });

  it('a rota genérica continua recusando aprovação fora da fila de ações', async () => {
    const decisionId = await seedDecision(empresaId);
    const res = await api('POST', `/api/dot/decisions/${decisionId}/approve`);
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'DOT_APPROVAL_REQUIRES_ACTION');
  });

  it('opção inválida é rejeitada e decisão de outra empresa não é encontrada', async () => {
    const decisionId = await seedDecision(empresaId);
    const invalid = await api('POST', `/api/dot/decisions/${decisionId}/prepare-action`, { optionId: 'opcao_9' });
    assert.equal(invalid.status, 400);

    const crossTenant = await api('POST', `/api/dot/decisions/${decisionId}/prepare-action`, { optionId: 'opcao_1' }, outraEmpresaId);
    assert.equal(crossTenant.status, 404, 'decisão de outra empresa não é encontrada');
  });
});

describe('A1 (HTTP): aprovar → executar → missão retomada e concluída', () => {
  it('fluxo completo pela API com a missão vinculada', async () => {
    // Objetivo + missão (o worker em background está desligado neste teste).
    const created = await api('POST', '/api/dot/agent/goals', { title: 'Reduzir reclamações sobre tempo de espera' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const missionId = Number(created.data.mission?.id);
    assert.ok(missionId > 0);

    // observe → investigate → recommend → prepare
    for (const expected of [/Contexto observado/, /Investigação do objetivo/, /Recomendação registrada/, /preparada/]) {
      const step = await api('POST', `/api/dot/agent/missions/${missionId}/run-step`);
      assert.equal(step.status, 200, JSON.stringify(step.data));
      assert.equal(step.data.blocked, false);
      assert.match(String(step.data.output), expected);
    }

    // A listagem expõe a ação vinculada pronta para aprovação.
    const listed = await api('GET', '/api/dot/agent/missions');
    assert.equal(listed.status, 200);
    const mission = listed.data.missions.find((item: any) => Number(item.id) === missionId);
    assert.ok(mission);
    assert.equal(String(mission.status), 'waiting_approval');
    assert.equal(String(mission.approval_action?.status), 'prepared');
    const actionId = Number(mission.approval_action?.id);
    assert.ok(actionId > 0);

    // Executar sem aprovar é recusado pela API.
    const runBeforeApproval = await api('POST', `/api/dot/actions/${actionId}/run`);
    assert.equal(runBeforeApproval.status, 409);
    assert.equal(runBeforeApproval.data.ok, false);

    // Aprovação explícita: não executa nada.
    const approved = await api('POST', `/api/dot/actions/${actionId}/approve`);
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.equal(String(approved.data.action?.status), 'approved');
    assert.equal(approved.data.execution, null);

    const stillWaiting = await api('GET', '/api/dot/agent/missions');
    const missionAfterApproval = stillWaiting.data.missions.find((item: any) => Number(item.id) === missionId);
    assert.equal(String(missionAfterApproval?.status), 'waiting_approval');

    // Execução real pelo gateway: a missão vinculada é retomada e concluída.
    const run = await api('POST', `/api/dot/actions/${actionId}/run`);
    assert.equal(run.status, 200, JSON.stringify(run.data));
    assert.equal(run.data.ok, true);
    assert.equal(run.data.external_side_effect, false);
    assert.equal(run.data.resume_error, null);
    assert.equal(String(run.data.resumed_mission?.status), 'completed');

    const finished = await api('GET', '/api/dot/agent/missions');
    const missionFinished = finished.data.missions.find((item: any) => Number(item.id) === missionId);
    assert.equal(String(missionFinished?.status), 'completed');
    assert.equal(String(missionFinished?.approval_action?.status), 'executed');
  });

  it('retomada só existe para missão pausada', async () => {
    const listed = await api('GET', '/api/dot/agent/missions');
    const missionId = Number(listed.data.missions[0]?.id);
    assert.ok(missionId > 0);

    const resume = await api('POST', `/api/dot/agent/missions/${missionId}/resume`);
    assert.equal(resume.status, 409, 'missão concluída não pode ser retomada');
    assert.equal(resume.data.ok, false);
    assert.match(String(resume.data.error), /não está pausada/i);
  });
});
