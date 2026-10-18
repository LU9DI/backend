/**
 * Proteção de rotas do Dot (HTTP): propriedade autoritativa, PIN administrativo
 * e sessão exclusiva.
 *
 * Regressões cobertas (a matriz completa está em docs/DOT_PRODUCAO.md):
 *  - funcionário com papel padrão `empresa` NÃO administra permissões (antes da
 *    correção este era o furo: qualquer usuário logado tinha canManage);
 *  - somente o proprietário cadastra PIN / abre sessão; empresa sem dono nega;
 *  - sessão é cookie opaco selado no servidor, vinculado a empresa+usuário,
 *    com expiração, revogação e invalidação na redefinição do PIN;
 *  - mutações administrativas exigem o cabeçalho X-Dot-Admin (anti-CSRF);
 *  - execução de ações exige a sessão; ferramentas de leitura continuam
 *    acessíveis com permissão granular (produto preservado);
 *  - provisionamento de proprietário é exclusivo do admin da plataforma,
 *    validado contra o banco e auditado.
 */
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDb = path.join(os.tmpdir(), `filtra-dot-route-protection-${Date.now()}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.DOT_AGENT_WORKER_ENABLED = '0';
delete process.env.DOT_DEMO_MODE;

const SENHA_OWNER = 'SenhaForte-12345';
const PIN_INICIAL = '482915';
const PIN_NOVO = '807261';

let server: any;
let baseUrl = '';
let signAccessToken: (payload: any) => string;
let getDb: any;

const empresaA = crypto.randomUUID();
const empresaB = crypto.randomUUID();
const empresaC = crypto.randomUUID();
const ownerA = crypto.randomUUID();
const employeeA = crypto.randomUUID();
const ownerB = crypto.randomUUID();
const ownerC = crypto.randomUUID();

function tokenFor(userId: string, empresaId: string, role = 'empresa') {
  return signAccessToken({
    id: userId,
    nome_funcionario: 'Usuário Teste',
    empresa_id: empresaId,
    role,
  });
}

async function request(
  method: string,
  pathName: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.headers || {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') || '' };
}

async function unlock(token: string, pin: string) {
  return request('POST', '/api/dot/admin/session', {
    token,
    body: { pin },
    headers: { 'X-Dot-Admin': '1' },
  });
}

async function clearPinDelay(empresaId: string, userId: string) {
  await getDb().run(
    'UPDATE dot_admin_pin_attempts SET failed_count = 0, lock_until = NULL WHERE empresa_id = ? AND user_id = ?',
    [empresaId, userId],
  );
}

async function seedEmpresa(id: string, plan = 'rei') {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 30 * 86400000).toISOString();
  await getDb().run(
    'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
    [id, 'cnpj-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14), 'Empresa Proteção', 'slug-' + id.slice(0, 8), 'ativo', plan, now, future],
  );
}

async function seedUsuario(id: string, empresaId: string, email: string) {
  const senhaHash = await bcrypt.hash(SENHA_OWNER, 4);
  await getDb().run(
    'INSERT INTO usuarios (id,cnpj,nome_funcionario,empresa_id,senha_hash,email) VALUES (?,?,?,?,?,?)',
    [id, '00000000000000', 'Usuário Teste', empresaId, senhaHash, email],
  );
}

function adminHeaders(cookie: string) {
  return { 'X-Dot-Admin': '1', Cookie: cookie };
}

const PERMISSION_BODY = { resource: 'operations', action: 'create', granted: true };

before(async () => {
  const { default: express } = await import('express');
  const cookieParser = (await import('cookie-parser')).default;
  const { initDB, getDb: db } = await import('../lib/db.js');
  const { signAccessToken: sign } = await import('../lib/auth.js');
  const { mountDotRoutes } = await import('../routes/dotRoutes.js');
  const { mountDotAccessRoutes } = await import('../routes/dotAccessRoutes.js');
  const { mountDotAdminRoutes } = await import('../routes/dotAdminRoutes.js');
  const { mountAdminOwnerRoutes } = await import('../routes/adminOwnerRoutes.js');
  const { ensureDotAccessSchema } = await import('../services/dotAccessControl.js');
  const { ensureDotAgentSchema } = await import('../services/dotAgent.js');
  const { ensureMissionTables } = await import('../services/dotAgentMissions.js');
  const { ensureEmpresaOwnerSchema, provisionEmpresaOwner } = await import('../lib/empresaOwnership.js');
  const { ensureDotAdminSecuritySchema } = await import('../services/dotAdminSecurity.js');
  const { listDotDecisions } = await import('../services/dotDecision.js');
  const { listDotActions } = await import('../services/dotActionQueue.js');

  await initDB();
  await ensureDotAccessSchema();
  await ensureDotAgentSchema();
  await ensureMissionTables();
  await ensureEmpresaOwnerSchema();
  await ensureDotAdminSecuritySchema();
  signAccessToken = sign;
  getDb = db;

  const e = express();
  e.use(cookieParser());
  e.use(express.json({ limit: '32kb' }));
  mountDotRoutes(e);
  mountDotAccessRoutes(e);
  mountDotAdminRoutes(e);
  mountAdminOwnerRoutes(e);
  e.use((err: any, _req: any, res: any, _next: any) => {
    const status = Number(err?.status) || 500;
    res.status(status).json({ error: String(err?.message || 'Erro de teste.'), status });
  });

  await seedEmpresa(empresaA, 'rei');
  await seedEmpresa(empresaB, 'rei');
  await seedEmpresa(empresaC, 'corporativo');
  await seedUsuario(ownerA, empresaA, 'owner-a@teste.local');
  await seedUsuario(employeeA, empresaA, 'funcionario@teste.local');
  await seedUsuario(ownerB, empresaB, 'owner-b@teste.local');
  await seedUsuario(ownerC, empresaC, 'owner-c@teste.local');
  // A empresa C fica SEM proprietário de propósito (teste do provisionamento).
  await provisionEmpresaOwner(empresaA, ownerA, { source: 'test' });
  await provisionEmpresaOwner(empresaB, ownerB, { source: 'test' });

  // Tabelas usadas indiretamente pelo endpoint de execução (fila de ações).
  await listDotDecisions(empresaA);
  await listDotActions(empresaA);

  server = e.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  try {
    fs.unlinkSync(tmpDb);
  } catch {
    /* ok */
  }
});

describe('Propriedade: administração é exclusiva do proprietário', () => {
  it('funcionário com papel padrão não administra; proprietário exige cabeçalho e sessão', async () => {
    const ownerTok = tokenFor(ownerA, empresaA);
    const empTok = tokenFor(employeeA, empresaA, 'empresa');

    // Regressão do furo original: qualquer usuário tinha canManagePermissions.
    const employeePut = await request('PUT', '/api/dot/agent/permissions', {
      token: empTok,
      body: PERMISSION_BODY,
      headers: { 'X-Dot-Admin': '1' },
    });
    assert.equal(employeePut.status, 403);
    assert.equal(employeePut.data.code, 'DOT_PERMISSION_ADMIN_REQUIRED');

    // Listagem continua disponível para o funcionário (can_manage=false).
    const employeeGet = await request('GET', '/api/dot/agent/permissions', { token: empTok });
    assert.equal(employeeGet.status, 200);
    assert.equal(employeeGet.data.can_manage, false);

    // Proprietário sem cabeçalho → recusado.
    const noHeader = await request('PUT', '/api/dot/agent/permissions', {
      token: ownerTok,
      body: PERMISSION_BODY,
    });
    assert.equal(noHeader.status, 403);
    assert.equal(noHeader.data.code, 'DOT_ADMIN_HEADER_REQUIRED');

    // Proprietário com cabeçalho, mas sem sessão → recusado.
    const noSession = await request('PUT', '/api/dot/agent/permissions', {
      token: ownerTok,
      body: PERMISSION_BODY,
      headers: { 'X-Dot-Admin': '1' },
    });
    assert.equal(noSession.status, 403);
    assert.equal(noSession.data.code, 'DOT_ADMIN_SESSION_REQUIRED');

    // Estado visto pelo funcionário não expõe dados administrativos.
    const stateEmp = await request('GET', '/api/dot/admin/state', { token: empTok });
    assert.equal(stateEmp.status, 200);
    assert.equal(stateEmp.data.is_owner, false);
    assert.equal(stateEmp.data.pin_configured, null);
    assert.equal(stateEmp.data.session_active, false);
  });
});

describe('PIN administrativo: cadastro somente pelo proprietário', () => {
  it('funcionário não cadastra PIN; proprietário cadastra uma única vez', async () => {
    const ownerTok = tokenFor(ownerA, empresaA);
    const empTok = tokenFor(employeeA, empresaA, 'empresa');

    const stateBefore = await request('GET', '/api/dot/admin/state', { token: ownerTok });
    assert.equal(stateBefore.data.is_owner, true);
    assert.equal(stateBefore.data.pin_configured, false);

    // Funcionário: nem cadastro nem desbloqueio.
    const empSet = await request('POST', '/api/dot/admin/pin', {
      token: empTok,
      body: { pin: PIN_INICIAL },
      headers: { 'X-Dot-Admin': '1' },
    });
    assert.equal(empSet.status, 403);
    assert.equal(empSet.data.code, 'DOT_OWNER_REQUIRED');
    const empUnlock = await unlock(empTok, PIN_INICIAL);
    assert.equal(empUnlock.status, 403);
    assert.equal(empUnlock.data.code, 'DOT_OWNER_REQUIRED');

    // Cabeçalho obrigatório.
    const noHeader = await request('POST', '/api/dot/admin/pin', {
      token: ownerTok,
      body: { pin: PIN_INICIAL },
    });
    assert.equal(noHeader.status, 403);
    assert.equal(noHeader.data.code, 'DOT_ADMIN_HEADER_REQUIRED');

    // PIN previsível é recusado no cadastro.
    const weak = await request('POST', '/api/dot/admin/pin', {
      token: ownerTok,
      body: { pin: '123456' },
      headers: { 'X-Dot-Admin': '1' },
    });
    assert.equal(weak.status, 400);
    assert.equal(weak.data.code, 'DOT_ADMIN_PIN_FORMAT');

    const created = await request('POST', '/api/dot/admin/pin', {
      token: ownerTok,
      body: { pin: PIN_INICIAL },
      headers: { 'X-Dot-Admin': '1' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));

    const stateAfter = await request('GET', '/api/dot/admin/state', { token: ownerTok });
    assert.equal(stateAfter.data.pin_configured, true);
    assert.equal(stateAfter.data.session_active, false);

    // Segunda configuração nunca sobrescreve o PIN existente.
    const duplicate = await request('POST', '/api/dot/admin/pin', {
      token: ownerTok,
      body: { pin: PIN_NOVO },
      headers: { 'X-Dot-Admin': '1' },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, 'DOT_ADMIN_PIN_EXISTS');
  });
});

describe('Sessão administrativa: emissão, uso e vínculos', () => {
  it('PIN errado tem atraso progressivo; sessão válida libera a administração', async () => {
    const ownerTok = tokenFor(ownerA, empresaA);
    const empTok = tokenFor(employeeA, empresaA, 'empresa');
    const ownerBTok = tokenFor(ownerB, empresaB);

    // PIN errado: mensagem genérica, atraso progressivo persistido no banco.
    const wrong = await unlock(ownerTok, '000001');
    assert.equal(wrong.status, 403);
    assert.equal(wrong.data.code, 'DOT_ADMIN_PIN_INVALID');
    assert.ok(Number(wrong.data.retry_after_ms) > 0);
    assert.ok(!JSON.stringify(wrong.data).includes(PIN_INICIAL), 'resposta nunca contém o PIN');

    // Durante o atraso, nem o PIN correto passa.
    const duringDelay = await unlock(ownerTok, PIN_INICIAL);
    assert.equal(duringDelay.status, 429);
    assert.equal(duringDelay.data.code, 'DOT_ADMIN_LOCKED');

    // Vencido o atraso, o proprietário desbloqueia de verdade.
    await clearPinDelay(empresaA, ownerA);
    const unlocked = await unlock(ownerTok, PIN_INICIAL);
    assert.equal(unlocked.status, 200, JSON.stringify(unlocked.data));
    const cookie = unlocked.setCookie.split(';')[0];
    assert.match(cookie, /^dot_admin_session=/);
    assert.ok(unlocked.data.expires_at);

    // /admin/state reflete a sessão ativa.
    const stateWithSession = await request('GET', '/api/dot/admin/state', {
      token: ownerTok,
      headers: { Cookie: cookie },
    });
    assert.equal(stateWithSession.data.session_active, true);
    assert.equal(stateWithSession.data.session_expires_at, unlocked.data.expires_at);

    // Com a sessão, o proprietário altera permissões (grant auditado).
    const putOk = await request('PUT', '/api/dot/agent/permissions', {
      token: ownerTok,
      body: PERMISSION_BODY,
      headers: adminHeaders(cookie),
    });
    assert.equal(putOk.status, 200, JSON.stringify(putOk.data));
    const row = await getDb().get(
      'SELECT granted, granted_by FROM dot_agent_permissions WHERE empresa_id = ? AND resource = ? AND action = ? AND user_id IS NULL',
      [empresaA, 'operations', 'create'],
    );
    assert.equal(Number(row.granted), 1);
    assert.equal(String(row.granted_by), ownerA);

    // Cookie forjado → recusado.
    const forged = await request('PUT', '/api/dot/agent/permissions', {
      token: ownerTok,
      body: { ...PERMISSION_BODY, granted: false },
      headers: { 'X-Dot-Admin': '1', Cookie: 'dot_admin_session=token-forjado' },
    });
    assert.equal(forged.status, 403);
    assert.equal(forged.data.code, 'DOT_ADMIN_SESSION_REQUIRED');

    // Sessão do proprietário + JWT de funcionário → funcionário continua sem administrar.
    const employeeWithCookie = await request('PUT', '/api/dot/agent/permissions', {
      token: empTok,
      body: { ...PERMISSION_BODY, granted: false },
      headers: adminHeaders(cookie),
    });
    assert.equal(employeeWithCookie.status, 403);
    assert.equal(employeeWithCookie.data.code, 'DOT_PERMISSION_ADMIN_REQUIRED');

    // Sessão da empresa A não serve para o proprietário da empresa B (sem troca de escopo).
    const crossEmpresa = await request('PUT', '/api/dot/agent/permissions', {
      token: ownerBTok,
      body: { ...PERMISSION_BODY, granted: false },
      headers: adminHeaders(cookie),
    });
    assert.equal(crossEmpresa.status, 403);
    assert.equal(crossEmpresa.data.code, 'DOT_ADMIN_SESSION_REQUIRED');
  });

  it('expiração e bloqueio (lock) invalidam a sessão', async () => {
    const ownerTok = tokenFor(ownerA, empresaA);
    await clearPinDelay(empresaA, ownerA);
    const unlocked = await unlock(ownerTok, PIN_INICIAL);
    assert.equal(unlocked.status, 200);
    const cookie = unlocked.setCookie.split(';')[0];

    // Expiração no banco (validação é sempre no servidor).
    await getDb().run(
      'UPDATE dot_admin_sessions SET expires_at = ? WHERE empresa_id = ? AND revoked_at IS NULL',
      [new Date(Date.now() - 1000).toISOString(), empresaA],
    );
    const expired = await request('PUT', '/api/dot/agent/permissions', {
      token: ownerTok,
      body: { ...PERMISSION_BODY, granted: false },
      headers: adminHeaders(cookie),
    });
    assert.equal(expired.status, 403);
    assert.equal(expired.data.code, 'DOT_ADMIN_SESSION_REQUIRED');

    // Reabre e revoga explicitamente pelo endpoint (lock).
    const unlocked2 = await unlock(ownerTok, PIN_INICIAL);
    assert.equal(unlocked2.status, 200);
    const cookie2 = unlocked2.setCookie.split(';')[0];
    const lock = await request('DELETE', '/api/dot/admin/session', {
      token: ownerTok,
      headers: adminHeaders(cookie2),
    });
    assert.equal(lock.status, 200);
    const afterLock = await request('PUT', '/api/dot/agent/permissions', {
      token: ownerTok,
      body: { ...PERMISSION_BODY, granted: false },
      headers: adminHeaders(cookie2),
    });
    assert.equal(afterLock.status, 403);
    assert.equal(afterLock.data.code, 'DOT_ADMIN_SESSION_REQUIRED');
  });
});

describe('Redefinição do PIN: senha atual + invalidação das sessões', () => {
  it('exige a senha do proprietário, sobe a versão e derruba as sessões', async () => {
    const ownerTok = tokenFor(ownerA, empresaA);
    await clearPinDelay(empresaA, ownerA);
    const unlocked = await unlock(ownerTok, PIN_INICIAL);
    assert.equal(unlocked.status, 200);
    const cookieOld = unlocked.setCookie.split(';')[0];

    const wrongPass = await request('POST', '/api/dot/admin/pin/reset', {
      token: ownerTok,
      body: { pin: PIN_NOVO, senha: 'senha-errada' },
      headers: { 'X-Dot-Admin': '1' },
    });
    assert.equal(wrongPass.status, 403);
    assert.equal(wrongPass.data.code, 'DOT_ADMIN_PASSWORD_MISMATCH');

    const reset = await request('POST', '/api/dot/admin/pin/reset', {
      token: ownerTok,
      body: { pin: PIN_NOVO, senha: SENHA_OWNER },
      headers: { 'X-Dot-Admin': '1' },
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.data));
    assert.equal(reset.data.version, 2);

    // Sessão anterior (da versão antiga) não vale mais.
    const oldSession = await request('PUT', '/api/dot/agent/permissions', {
      token: ownerTok,
      body: { ...PERMISSION_BODY, granted: false },
      headers: adminHeaders(cookieOld),
    });
    assert.equal(oldSession.status, 403);
    assert.equal(oldSession.data.code, 'DOT_ADMIN_SESSION_REQUIRED');

    // PIN antigo rejeitado; PIN novo desbloqueia.
    const oldPin = await unlock(ownerTok, PIN_INICIAL);
    assert.equal(oldPin.status, 403);
    assert.equal(oldPin.data.code, 'DOT_ADMIN_PIN_INVALID');
    await clearPinDelay(empresaA, ownerA);
    const newPin = await unlock(ownerTok, PIN_NOVO);
    assert.equal(newPin.status, 200, JSON.stringify(newPin.data));
  });
});

describe('Provisionamento de proprietário: exclusivo do admin da plataforma', () => {
  it('valida token admin, pertencimento do usuário e libera a administração', async () => {
    const adminTok = signAccessToken({
      id: 'admin-plataforma',
      nome_funcionario: 'Admin Plataforma',
      empresa_id: 'admin',
      role: 'admin',
    });
    const ownerCTok = tokenFor(ownerC, empresaC);
    const empTok = tokenFor(employeeA, empresaA);

    const noToken = await request('POST', `/api/admin/empresas/${empresaC}/owner`, {
      body: { user_id: ownerC },
    });
    assert.equal(noToken.status, 401);

    const notAdmin = await request('POST', `/api/admin/empresas/${empresaC}/owner`, {
      token: empTok,
      body: { user_id: ownerC },
    });
    assert.equal(notAdmin.status, 403);

    const stateBefore = await request('GET', '/api/dot/admin/state', { token: ownerCTok });
    assert.equal(stateBefore.data.is_owner, false);
    assert.equal(stateBefore.data.owner_provisioned, false);

    // Usuário de OUTRA empresa é rejeitado.
    const wrongEmpresa = await request('POST', `/api/admin/empresas/${empresaC}/owner`, {
      token: adminTok,
      body: { user_id: ownerB },
    });
    assert.equal(wrongEmpresa.status, 400);

    // Provisiona pelo e-mail.
    const provisioned = await request('POST', `/api/admin/empresas/${empresaC}/owner`, {
      token: adminTok,
      body: { email: 'owner-c@teste.local' },
    });
    assert.equal(provisioned.status, 200, JSON.stringify(provisioned.data));
    assert.equal(provisioned.data.owner.user_id, ownerC);

    // O novo proprietário passa a administrar (ainda sem PIN: exige sessão).
    const stateAfter = await request('GET', '/api/dot/admin/state', { token: ownerCTok });
    assert.equal(stateAfter.data.is_owner, true);
    assert.equal(stateAfter.data.owner_provisioned, true);
    assert.equal(stateAfter.data.pin_configured, false);
    const putAfter = await request('PUT', '/api/dot/agent/permissions', {
      token: ownerCTok,
      body: PERMISSION_BODY,
      headers: { 'X-Dot-Admin': '1' },
    });
    assert.equal(putAfter.status, 403);
    assert.equal(putAfter.data.code, 'DOT_ADMIN_SESSION_REQUIRED');

    // Consulta do proprietário pelo admin.
    const ownerInfo = await request('GET', `/api/admin/empresas/${empresaC}/owner`, { token: adminTok });
    assert.equal(ownerInfo.status, 200);
    assert.equal(ownerInfo.data.owner.user_id, ownerC);

    // Provisionamento fica auditado.
    const audit = await getDb().get(
      'SELECT action, target, actor_user_id FROM audit_logs WHERE empresa_id = ? AND action = ? ORDER BY id DESC LIMIT 1',
      [empresaC, 'empresa.owner_set'],
    );
    assert.ok(audit);
    assert.equal(String(audit.target), ownerC);
    assert.equal(String(audit.actor_user_id), 'admin-plataforma');
  });
});

describe('Ferramentas e execução: produto preservado, execução protegida', () => {
  it('ferramenta de leitura funciona para funcionário; execução exige sessão', async () => {
    const ownerTok = tokenFor(ownerA, empresaA);
    const empTok = tokenFor(employeeA, empresaA, 'empresa');

    const tools = await request('GET', '/api/dot/agent/tools', { token: empTok });
    assert.equal(tools.status, 200);
    assert.ok(Array.isArray(tools.data.tools) && tools.data.tools.length >= 1);

    // Ferramenta de leitura/baixa criticidade segue acessível sem sessão
    // administrativa (permissão granular baseline é suficiente).
    const invoke = await request('POST', '/api/dot/agent/tools/company.workspace.read/invoke', {
      token: empTok,
      body: {},
    });
    assert.equal(invoke.status, 200, JSON.stringify(invoke.data));

    // Execução sem sessão → negada antes de qualquer efeito.
    const runNoSession = await request('POST', '/api/dot/actions/999999/run', {
      token: ownerTok,
      headers: { 'X-Dot-Admin': '1' },
    });
    assert.equal(runNoSession.status, 403);
    assert.equal(runNoSession.data.code, 'DOT_ADMIN_SESSION_REQUIRED');

    // Com sessão válida, a barreira de sessão passa (ação inexistente → 409).
    await clearPinDelay(empresaA, ownerA);
    const unlocked = await unlock(ownerTok, PIN_NOVO);
    assert.equal(unlocked.status, 200, JSON.stringify(unlocked.data));
    const runWithSession = await request('POST', '/api/dot/actions/999999/run', {
      token: ownerTok,
      headers: adminHeaders(unlocked.setCookie.split(';')[0]),
    });
    assert.equal(runWithSession.status, 409, JSON.stringify(runWithSession.data));
  });
});
