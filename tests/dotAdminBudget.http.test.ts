/**
 * Rotas administrativas do orçamento do Dot — integração HTTP REAL.
 *
 * Diferente de `dotChatLedger.http.test.ts` (que fixa o usuário via
 * `filtra.test.auth`), este arquivo exercita o caminho de produção:
 *
 *  1. JWT real assinado com `JWT_SECRET` (cookie/`Authorization`);
 *  2. gate `resolveDotGate` (empresa ativa + plano Rei/Corporativo + proprietário);
 *  3. PIN administrativo + sessão exclusiva (`dot_admin_session` + `X-Dot-Admin`);
 *  4. autorização do proprietário (funcionário não é dono);
 *  5. reconciliação (settle/release) com efeito real no ledger e em `ai_usage`;
 *  6. auditoria (`dot.pin_set`, `dot.pin_verify_failed`, `dot.admin_session_issued`,
 *     `dot.budget_reconciled`, `dot.admin_session_revoked`);
 *  7. isolamento entre empresas (reserva de outro tenant não é reconciliável).
 *
 * Sem provedor de IA e sem rede: a rota administrativa não chama modelo algum.
 */
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

let sqliteAvailable = true;
try {
  await import('sqlite3');
  await import('sqlite');
} catch {
  sqliteAvailable = false;
}

const tmpDb = path.join(os.tmpdir(), `filtra-dot-admin-http-${Date.now()}-${process.pid}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.DOT_AGENT_WORKER_ENABLED = '0';
delete process.env.DOT_DEMO_MODE;
delete process.env.DATABASE_URL;
delete process.env.USE_SUPABASE_DB;

const suite = sqliteAvailable ? describe : describe.skip;

const PIN = '482915';
const SENHA = 'SenhaForte-12345';

// Empresa principal (caminho feliz), empresa de terceiro (isolamento) e
// empresa separada só para a tentativa de PIN errado (o bloqueio progressivo
// é por empresa+usuário e não deve contaminar o caminho feliz).
const EMP_A = `admin-a-${crypto.randomUUID()}`;
const EMP_B = `admin-b-${crypto.randomUUID()}`;
const EMP_C = `admin-c-${crypto.randomUUID()}`;

const USER_A = crypto.randomUUID();
const USER_A_NAO_DONO = crypto.randomUUID();
const USER_B = crypto.randomUUID();

let server: any;
let baseUrl = '';
let db: any;
let ledger: typeof import('../services/dotLedger.js');
let signAccessToken: (payload: { id: string; nome_funcionario: string; empresa_id: string; role?: string }) => string;

function tokenFor(userId: string, empresaId: string, role?: string) {
  return signAccessToken({ id: userId, nome_funcionario: 'Dono Teste', empresa_id: empresaId, role });
}

function cookieFrom(res: Response): string {
  const raw = typeof (res.headers as any).getSetCookie === 'function'
    ? (res.headers as any).getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  for (const entry of raw) {
    const match = /dot_admin_session=([^;]+)/.exec(entry || '');
    if (match) return match[1];
  }
  return '';
}

async function adminFetch(
  pathName: string,
  opts: {
    method?: string;
    token?: string;
    adminSession?: string;
    header?: boolean;
    body?: unknown;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.header) headers['X-Dot-Admin'] = '1';
  if (opts.adminSession) headers['Cookie'] = `dot_admin_session=${opts.adminSession}`;
  const res = await fetch(`${baseUrl}${pathName}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, cookie: cookieFrom(res) };
}

async function seedEmpresa(id: string) {
  const now = new Date().toISOString();
  const expira = new Date(Date.now() + 30 * 86_400_000).toISOString();
  await db.run(
    'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
    [id, `cnpj${id.replace(/\D/g, '').slice(0, 10)}`, 'Empresa Admin', `slug-${id.slice(-10)}`, 'ativo', 'rei', now, expira],
  );
}

async function seedUsuario(empresaId: string): Promise<string> {
  const id = crypto.randomUUID();
  const hash = await bcrypt.hash(SENHA, 4);
  await db.run(
    'INSERT INTO usuarios (id, cnpj, nome_funcionario, empresa_id, senha_hash) VALUES (?,?,?,?,?)',
    [id, '00000000000000', 'Dono Teste', empresaId, hash],
  );
  return id;
}

async function auditRows(empresaId: string, action: string) {
  return db.all(
    'SELECT action, result, detail FROM audit_logs WHERE empresa_id = ? AND action = ? ORDER BY id DESC',
    [empresaId, action],
  );
}

suite('Dot admin — orçamento por HTTP (JWT + PIN + sessão + reconciliação)', () => {
  before(async () => {
    const { initDB, getDb } = await import('../lib/db.js');
    await initDB();
    db = getDb();
    ledger = await import('../services/dotLedger.js');
    await ledger.ensureDotLedgerSchema();

    const jwtKeys: any = await import('../lib/jwtKeys.js');
    signAccessToken = jwtKeys.signAccessToken;

    const ownership: any = await import('../lib/empresaOwnership.js');
    const adminSecurity: any = await import('../services/dotAdminSecurity.js');

    for (const id of [EMP_A, EMP_B, EMP_C]) await seedEmpresa(id);
    // Usuário proprietário de A, um funcionário de A (NÃO proprietário) e o
    // proprietário de B.
    await db.run('INSERT INTO usuarios (id, cnpj, nome_funcionario, empresa_id, senha_hash) VALUES (?,?,?,?,?)', [
      USER_A, '00000000000000', 'Dono A', EMP_A, await bcrypt.hash(SENHA, 4),
    ]);
    await db.run('INSERT INTO usuarios (id, cnpj, nome_funcionario, empresa_id, senha_hash) VALUES (?,?,?,?,?)', [
      USER_A_NAO_DONO, '00000000000000', 'Funcionário A', EMP_A, await bcrypt.hash(SENHA, 4),
    ]);
    await db.run('INSERT INTO usuarios (id, cnpj, nome_funcionario, empresa_id, senha_hash) VALUES (?,?,?,?,?)', [
      USER_B, '00000000000000', 'Dono B', EMP_B, await bcrypt.hash(SENHA, 4),
    ]);

    await ownership.provisionEmpresaOwner(EMP_A, USER_A, { source: 'signup' });
    await ownership.provisionEmpresaOwner(EMP_B, USER_B, { source: 'signup' });
    await ownership.provisionEmpresaOwner(EMP_C, await seedUsuario(EMP_C), { source: 'signup' });

    // EMP_C já nasce com PIN configurado (via serviço) para o teste de PIN errado.
    const ownerC = await ownership.getEmpresaOwnerUserId(EMP_C);
    await adminSecurity.setDotAdminPinInitial(EMP_C, ownerC, PIN);

    const express = (await import('express')).default;
    const cookieParser = (await import('cookie-parser')).default;
    const { mountDotAdminRoutes } = await import('../routes/dotAdminRoutes.js');
    const app = express();
    app.use(express.json({ limit: '64kb' }));
    app.use(cookieParser());
    mountDotAdminRoutes(app);

    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server?.close();
    try {
      const { closeDB } = await import('../lib/db.js');
      await closeDB();
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(tmpDb);
    } catch {
      /* ok */
    }
  });

  test('sem JWT: o gate nega antes de qualquer dado de orçamento', async () => {
    const res = await adminFetch('/api/dot/admin/budget');
    assert.equal(res.status, 403);
    assert.equal(res.data.ok, false);
  });

  test('JWT de funcionário sem propriedade: 403 DOT_OWNER_REQUIRED', async () => {
    const res = await adminFetch('/api/dot/admin/budget', { token: tokenFor(USER_A_NAO_DONO, EMP_A) });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'DOT_OWNER_REQUIRED');
  });

  test('estado administrativo do proprietário: dono provisionado, PIN ainda não configurado', async () => {
    const res = await adminFetch('/api/dot/admin/state', { token: tokenFor(USER_A, EMP_A) });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.is_owner, true);
    assert.equal(res.data.owner_provisioned, true);
    assert.equal(res.data.pin_configured, false);
    assert.equal(res.data.session_active, false);
    assert.equal(res.data.header_required, true);
  });

  test('cadastro de PIN: cabeçalho obrigatório, formato validado e sucesso auditado', async () => {
    const semHeader = await adminFetch('/api/dot/admin/pin', {
      method: 'POST',
      token: tokenFor(USER_A, EMP_A),
      body: { pin: PIN },
    });
    assert.equal(semHeader.status, 403);
    assert.equal(semHeader.data.code, 'DOT_ADMIN_HEADER_REQUIRED');

    const fraco = await adminFetch('/api/dot/admin/pin', {
      method: 'POST',
      token: tokenFor(USER_A, EMP_A),
      header: true,
      body: { pin: '123456' },
    });
    assert.equal(fraco.status, 400);
    assert.equal(fraco.data.code, 'DOT_ADMIN_PIN_FORMAT');

    const ok = await adminFetch('/api/dot/admin/pin', {
      method: 'POST',
      token: tokenFor(USER_A, EMP_A),
      header: true,
      body: { pin: PIN },
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.equal(ok.data.ok, true);
    assert.equal(ok.data.version, 1);

    const auditoria = await auditRows(EMP_A, 'dot.pin_set');
    assert.equal(auditoria.length, 1);
    assert.equal(auditoria[0].result, 'ok');
  });

  test('segundo cadastro de PIN é recusado (não sobrescreve): 409 DOT_ADMIN_PIN_EXISTS', async () => {
    const res = await adminFetch('/api/dot/admin/pin', {
      method: 'POST',
      token: tokenFor(USER_A, EMP_A),
      header: true,
      body: { pin: '739204' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'DOT_ADMIN_PIN_EXISTS');
  });

  test('PIN errado: 403 DOT_ADMIN_PIN_INVALID e auditoria de falha (empresa isolada)', async () => {
    const ownerC = await (await import('../lib/empresaOwnership.js')).getEmpresaOwnerUserId(EMP_C);
    const tokenC = tokenFor(ownerC as string, EMP_C);
    const res = await adminFetch('/api/dot/admin/session', {
      method: 'POST',
      token: tokenC,
      header: true,
      body: { pin: '000001' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'DOT_ADMIN_PIN_INVALID');
    const auditoria = await auditRows(EMP_C, 'dot.pin_verify_failed');
    assert.equal(auditoria.length, 1);
    assert.equal(auditoria[0].result, 'denied');
  });

  test('PIN correto emite a sessão administrativa (cookie) e a audita', async () => {
    const res = await adminFetch('/api/dot/admin/session', {
      method: 'POST',
      token: tokenFor(USER_A, EMP_A),
      header: true,
      body: { pin: PIN },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.ok, true);
    assert.ok(res.cookie, 'a resposta precisa emitir o cookie dot_admin_session');

    const auditoria = await auditRows(EMP_A, 'dot.admin_session_issued');
    assert.equal(auditoria.length, 1);
    assert.equal(auditoria[0].result, 'ok');

    const state = await adminFetch('/api/dot/admin/state', { token: tokenFor(USER_A, EMP_A), adminSession: res.cookie });
    assert.equal(state.data.session_active, true);
  });

  test('visão de orçamento: agrega só o tenant do dono e não expõe dado sensível', async () => {
    const reserva = await ledger.reserveDotExecution({ empresaId: EMP_A, plan: 'rei' });
    assert.equal(reserva.ok, true);

    const res = await adminFetch('/api/dot/admin/budget', { token: tokenFor(USER_A, EMP_A) });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.ok(res.data.budget.limit > 0);
    assert.ok(res.data.budget.reserved > 0);
    assert.equal(res.data.open_reservations.length, 1);

    const raw = JSON.stringify(res.data);
    assert.ok(!raw.includes(USER_A), 'a rota não pode devolver o id do usuário');
    assert.ok(!raw.includes(USER_A_NAO_DONO));
    assert.ok(!/@/.test(raw), 'a rota não pode devolver e-mail');
    assert.deepEqual(
      Object.keys(res.data.open_reservations[0]).sort(),
      ['ambiguous', 'created_at', 'expires_at', 'id', 'provider', 'sent_at', 'status', 'tokens_estimated', 'tokens_reserved'].sort(),
    );
  });

  test('reconciliação sem sessão administrativa: 403 DOT_ADMIN_SESSION_REQUIRED', async () => {
    const pendente = await ledger.reserveDotExecution({ empresaId: EMP_A, plan: 'rei' });
    const res = await adminFetch('/api/dot/admin/budget/reconcile', {
      method: 'POST',
      token: tokenFor(USER_A, EMP_A),
      header: true,
      body: { reservation_id: pendente.reservation!.id, decision: 'release' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'DOT_ADMIN_SESSION_REQUIRED');
    // A reserva continua aberta: nada foi liberado sem sessão.
    const linha = await ledger.getDotReservation(EMP_A, pendente.reservation!.id);
    assert.equal(linha?.status, 'pending');
  });

  test('reconciliação settle com sessão: grava consumo real e audita', async () => {
    const sessao = await adminFetch('/api/dot/admin/session', {
      method: 'POST', token: tokenFor(USER_A, EMP_A), header: true, body: { pin: PIN },
    });
    assert.ok(sessao.cookie);

    const pendente = await ledger.reserveDotExecution({ empresaId: EMP_A, plan: 'rei' });
    const id = pendente.reservation!.id;

    const res = await adminFetch('/api/dot/admin/budget/reconcile', {
      method: 'POST',
      token: tokenFor(USER_A, EMP_A),
      header: true,
      adminSession: sessao.cookie,
      body: { reservation_id: id, decision: 'settle', tokens: 700, provider: 'groq', reason: 'tokens confirmados no registro do provedor' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.ok, true);
    assert.equal(res.data.result.reservation.status, 'settled');

    const linha = await ledger.getDotReservation(EMP_A, id);
    assert.equal(linha?.status, 'settled');
    assert.equal(Number(linha?.tokens_real), 700);
    const usage = await db.get(
      'SELECT COUNT(*) AS c, COALESCE(SUM(tokens),0) AS t FROM ai_usage WHERE empresa_id = ? AND feature = ?',
      [EMP_A, 'dot'],
    );
    assert.equal(Number(usage.c), 1);
    assert.equal(Number(usage.t), 700);

    const auditoria = await auditRows(EMP_A, 'dot.budget_reconciled');
    assert.equal(auditoria.length, 1);
    assert.equal(auditoria[0].result, 'ok');
    assert.match(String(auditoria[0].detail), /"decision":"settle"/);
  });

  test('reconciliação release sem confirmação explícita é recusada e preserva a reserva', async () => {
    const sessao = await adminFetch('/api/dot/admin/session', {
      method: 'POST', token: tokenFor(USER_A, EMP_A), header: true, body: { pin: PIN },
    });
    const pendente = await ledger.reserveDotExecution({ empresaId: EMP_A, plan: 'rei' });
    const id = pendente.reservation!.id;

    const res = await adminFetch('/api/dot/admin/budget/reconcile', {
      method: 'POST',
      token: tokenFor(USER_A, EMP_A),
      header: true,
      adminSession: sessao.cookie,
      body: { reservation_id: id, decision: 'release', reason: 'aparentemente não enviado' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'DOT_RECONCILE_NOT_SENT_CONFIRMATION_REQUIRED');
    assert.equal((await ledger.getDotReservation(EMP_A, id))?.status, 'pending');
  });

  test('reconciliação release com sessão: libera sem consumir e audita', async () => {
    const sessao = await adminFetch('/api/dot/admin/session', {
      method: 'POST', token: tokenFor(USER_A, EMP_A), header: true, body: { pin: PIN },
    });
    const pendente = await ledger.reserveDotExecution({ empresaId: EMP_A, plan: 'rei' });
    const id = pendente.reservation!.id;
    const antes = await db.get('SELECT COUNT(*) AS c FROM ai_usage WHERE empresa_id = ?', [EMP_A]);

    const res = await adminFetch('/api/dot/admin/budget/reconcile', {
      method: 'POST',
      token: tokenFor(USER_A, EMP_A),
      header: true,
      adminSession: sessao.cookie,
      body: { reservation_id: id, decision: 'release', reason: 'confirmado que não houve envio', confirm_not_sent: true },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.result.reservation.status, 'released');

    const depois = await db.get('SELECT COUNT(*) AS c FROM ai_usage WHERE empresa_id = ?', [EMP_A]);
    assert.equal(Number(depois.c), Number(antes.c), 'release não pode criar consumo');
  });

  test('entrada inválida da reconciliação: 400 com código específico', async () => {
    const sessao = await adminFetch('/api/dot/admin/session', {
      method: 'POST', token: tokenFor(USER_A, EMP_A), header: true, body: { pin: PIN },
    });
    const base = { token: tokenFor(USER_A, EMP_A), header: true, adminSession: sessao.cookie };

    const idInvalido = await adminFetch('/api/dot/admin/budget/reconcile', {
      method: 'POST', ...base, body: { reservation_id: 'abc', decision: 'settle' },
    });
    assert.equal(idInvalido.status, 400);
    assert.equal(idInvalido.data.code, 'DOT_RECONCILE_BAD_ID');

    const decisaoInvalida = await adminFetch('/api/dot/admin/budget/reconcile', {
      method: 'POST', ...base, body: { reservation_id: 1, decision: 'apagar' },
    });
    assert.equal(decisaoInvalida.status, 400);
    assert.equal(decisaoInvalida.data.code, 'DOT_RECONCILE_BAD_DECISION');

    const tokensInvalidos = await adminFetch('/api/dot/admin/budget/reconcile', {
      method: 'POST', ...base, body: { reservation_id: 1, decision: 'settle', tokens: -5 },
    });
    assert.equal(tokensInvalidos.status, 400);
    assert.equal(tokensInvalidos.data.code, 'DOT_RECONCILE_BAD_TOKENS');
  });

  test('isolamento entre empresas: reserva de outro tenant não é reconciliável', async () => {
    const sessao = await adminFetch('/api/dot/admin/session', {
      method: 'POST', token: tokenFor(USER_A, EMP_A), header: true, body: { pin: PIN },
    });
    const reservaB = await ledger.reserveDotExecution({ empresaId: EMP_B, plan: 'rei' });
    const idB = reservaB.reservation!.id;

    const res = await adminFetch('/api/dot/admin/budget/reconcile', {
      method: 'POST',
      token: tokenFor(USER_A, EMP_A),
      header: true,
      adminSession: sessao.cookie,
      body: { reservation_id: idB, decision: 'settle', tokens: 999, provider: 'groq', reason: 'teste de isolamento entre empresas' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'DOT_RECONCILE_REFUSED');

    const linhaB = await ledger.getDotReservation(EMP_B, idB);
    assert.equal(linhaB?.status, 'pending', 'a reserva de outra empresa não pode mudar');
    const usageB = await db.get('SELECT COUNT(*) AS c FROM ai_usage WHERE empresa_id = ?', [EMP_B]);
    assert.equal(Number(usageB.c), 0, 'nenhum consumo pode ser lançado na outra empresa');
  });

  test('bloqueio de sessão revoga o cookie, audita e invalida a reconciliação seguinte', async () => {
    const sessao = await adminFetch('/api/dot/admin/session', {
      method: 'POST', token: tokenFor(USER_A, EMP_A), header: true, body: { pin: PIN },
    });
    const revoke = await adminFetch('/api/dot/admin/session', {
      method: 'DELETE', token: tokenFor(USER_A, EMP_A), header: true, adminSession: sessao.cookie,
    });
    assert.equal(revoke.status, 200);
    assert.equal(revoke.data.ok, true);

    const auditoria = await auditRows(EMP_A, 'dot.admin_session_revoked');
    assert.equal(auditoria.length, 1);

    const pendente = await ledger.reserveDotExecution({ empresaId: EMP_A, plan: 'rei' });
    const res = await adminFetch('/api/dot/admin/budget/reconcile', {
      method: 'POST',
      token: tokenFor(USER_A, EMP_A),
      header: true,
      adminSession: sessao.cookie,
      body: { reservation_id: pendente.reservation!.id, decision: 'release' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'DOT_ADMIN_SESSION_REQUIRED');
  });
});
