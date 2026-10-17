/**
 * M1 — gate único de plano/assinatura para todas as rotas de empresa do Dot.
 *
 * A matriz real: Rei, Corporativo e o alias `corp` têm Dot; trial de 7 dias,
 * Ultra, Pro e Inicial NÃO têm. O gate vale para /api/dot/agent/* inteiro
 * (workspace, permissions, tools, goals e missions), não só para uma rota.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDb = path.join(os.tmpdir(), `filtra-dot-gate-${Date.now()}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.DOT_AGENT_WORKER_ENABLED = '0';
delete process.env.DOT_DEMO_MODE;

let server: any;
let baseUrl = '';
let signAccessToken: (payload: any) => string;
let getDb: any;
let setDotPermission: any;

const empresas = {
  rei: crypto.randomUUID(),
  corporativo: crypto.randomUUID(),
  corp: crypto.randomUUID(),
  trial: crypto.randomUUID(),
  ultra: crypto.randomUUID(),
  pro: crypto.randomUUID(),
  inicial: crypto.randomUUID(),
  inativo: crypto.randomUUID(),
};

function tokenFor(empresaId: string, role = 'empresa') {
  return signAccessToken({
    id: `user-${empresaId.slice(0, 8)}`,
    nome_funcionario: 'Responsável Teste',
    empresa_id: empresaId,
    role,
  });
}

async function seedEmpresa(id: string, plan: string, status = 'ativo', expiraEm: string | null = null) {
  await getDb().run(
    'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
    [id, 'cnpj-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14), `Empresa ${plan}`, 'slug-' + id.slice(0, 8), status, plan, new Date().toISOString(), expiraEm],
  );
}

async function get(pathName: string, token?: string) {
  const res = await fetch(`${baseUrl}${pathName}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function post(pathName: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${pathName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

before(async () => {
  const { default: express } = await import('express');
  const cookieParser = (await import('cookie-parser')).default;
  const { initDB, getDb: db } = await import('../lib/db.js');
  const { signAccessToken: sign } = await import('../lib/auth.js');
  const { mountDotAgentRoutes } = await import('../routes/dotAgentRoutes.js');
  const { mountDotAgentMissionRoutes } = await import('../routes/dotAgentMissionRoutes.js');
  const { mountDotAccessRoutes } = await import('../routes/dotAccessRoutes.js');
  const { ensureDotAccessSchema, setDotPermission: setPerm } = await import('../services/dotAccessControl.js');
  const { ensureDotAgentSchema } = await import('../services/dotAgent.js');
  const { ensureMissionTables } = await import('../services/dotAgentMissions.js');

  await initDB();
  await ensureDotAccessSchema();
  await ensureDotAgentSchema();
  await ensureMissionTables();
  signAccessToken = sign;
  getDb = db;
  setDotPermission = setPerm;

  const e = express();
  e.use(cookieParser());
  e.use(express.json({ limit: '20kb' }));
  mountDotAgentRoutes(e);
  mountDotAgentMissionRoutes(e);
  mountDotAccessRoutes(e);

  await new Promise<void>((resolve) => {
    server = e.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  const future = new Date(Date.now() + 30 * 86400000).toISOString();
  await seedEmpresa(empresas.rei, 'rei', 'ativo', future);
  await seedEmpresa(empresas.corporativo, 'corporativo', 'ativo', future);
  await seedEmpresa(empresas.corp, 'corp', 'ativo', future);
  await seedEmpresa(empresas.trial, 'trial', 'trial', future);
  await seedEmpresa(empresas.ultra, 'ultra', 'ativo', future);
  await seedEmpresa(empresas.pro, 'pro', 'ativo', future);
  await seedEmpresa(empresas.inicial, 'inicial', 'ativo', future);
  await seedEmpresa(empresas.inativo, 'rei', 'bloqueado', future);
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    fs.unlinkSync(tmpDb);
  } catch {
    /* ok */
  }
});

describe('M1: gate de plano do Dot em /api/dot/agent/*', () => {
  it('libera workspace, permissions, tools e missions para rei/corporativo/corp', async () => {
    for (const key of ['rei', 'corporativo', 'corp'] as const) {
      const token = tokenFor(empresas[key]);
      const workspace = await get('/api/dot/agent/workspace', token);
      assert.equal(workspace.status, 200, `${key}: ${JSON.stringify(workspace.data)}`);
      const permissions = await get('/api/dot/agent/permissions', token);
      assert.equal(permissions.status, 200, `${key} permissions`);
      const tools = await get('/api/dot/agent/tools', token);
      assert.equal(tools.status, 200, `${key} tools`);
      const missions = await get('/api/dot/agent/missions', token);
      assert.equal(missions.status, 200, `${key} missions`);
    }
  });

  it('nega trial de 7 dias: o trial não concede o Dot', async () => {
    const token = tokenFor(empresas.trial);
    for (const route of [
      '/api/dot/agent/workspace',
      '/api/dot/agent/permissions',
      '/api/dot/agent/tools',
      '/api/dot/agent/missions',
    ]) {
      const res = await get(route, token);
      assert.equal(res.status, 403, `${route} deveria negar o trial`);
      assert.equal(res.data.ok, false);
      assert.match(String(res.data.error), /acesso antecipado|Rei e Corporativo/i);
    }
  });

  it('nega planos fora da matriz e empresa bloqueada', async () => {
    for (const key of ['ultra', 'pro', 'inicial'] as const) {
      const res = await get('/api/dot/agent/workspace', tokenFor(empresas[key]));
      assert.equal(res.status, 403, `${key} não deveria ter Dot`);
      assert.match(String(res.data.error), /acesso antecipado|Rei e Corporativo/i);
    }
    const bloqueada = await get('/api/dot/agent/workspace', tokenFor(empresas.inativo));
    assert.equal(bloqueada.status, 403);
    assert.match(String(bloqueada.data.error), /Assinatura\/trial inativo/i);
  });

  it('nega sem token e com token inválido', async () => {
    assert.equal((await get('/api/dot/agent/workspace')).status, 403);
    assert.equal((await get('/api/dot/agent/workspace', 'token-invalido')).status, 403);
  });

  it('nega conta admin da plataforma', async () => {
    const admin = signAccessToken({ id: 'admin-1', nome_funcionario: 'Admin', empresa_id: 'admin', role: 'admin' });
    const res = await get('/api/dot/agent/workspace', admin);
    assert.equal(res.status, 403);
    assert.match(String(res.data.error), /admin/i);
  });

  it('nega mutação de missão sem permissão e não cruza empresas', async () => {
    // Concede via serviço canônico (upsert): o baseline interno do gate já
    // pode ter criado operations.execute para estes planos, e um INSERT cru
    // colidiria com o índice único ux_dot_permissions_scope.
    for (const [empresa, resource, action] of [
      [empresas.rei, 'operations', 'create'],
      [empresas.rei, 'operations', 'execute'],
      [empresas.corp, 'operations', 'execute'],
    ] as const) {
      await setDotPermission(empresa, { resource, action, granted: true, grantedBy: 'teste' });
    }
    const tokenRei = tokenFor(empresas.rei);
    const tokenCorp = tokenFor(empresas.corp);

    // Sem operations.create, criar objetivo/missão é negado.
    const denied = await post('/api/dot/agent/goals', { title: 'Objetivo sem permissão' }, tokenCorp);
    assert.equal(denied.status, 403);
    assert.equal(denied.data.ok, false);

    // Com permissão, a empresa Rei cria o próprio objetivo e a missão.
    const created = await post('/api/dot/agent/goals', { title: 'Objetivo da empresa Rei' }, tokenRei);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const missionId = Number(created.data.mission?.id);
    assert.ok(missionId > 0);

    // Outra empresa não enxerga nem retoma a missão.
    const other = await get('/api/dot/agent/missions', tokenCorp);
    assert.equal(other.status, 200);
    assert.deepEqual(other.data.missions, []);
    const resume = await post(`/api/dot/agent/missions/${missionId}/resume`, {}, tokenCorp);
    assert.equal(resume.status, 404, 'missão de outra empresa não é encontrada');

    // A empresa dona vê a própria missão.
    const own = await get('/api/dot/agent/missions', tokenRei);
    assert.equal(own.status, 200);
    assert.equal(own.data.missions.length, 1);
  });

  it('demo mode nunca libera sem token em produção', async () => {
    process.env.DOT_DEMO_MODE = '1';
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await get('/api/dot/agent/workspace');
      assert.equal(res.status, 403);
    } finally {
      process.env.NODE_ENV = previousEnv;
      delete process.env.DOT_DEMO_MODE;
    }
  });
});
