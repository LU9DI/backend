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

function platformAdminToken() {
  return signAccessToken({ id: 'platform-admin-test', nome_funcionario: 'Operador Plataforma', empresa_id: 'admin', role: 'admin' });
}

async function reconcileFetch(body: unknown, opts: { header?: boolean; token?: string } = {}) {
  return adminFetch('/api/admin/dot/budget/reconcile', {
    method: 'POST',
    token: opts.token || platformAdminToken(),
    header: opts.header !== false,
    body,
  });
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

  test('proprietário do tenant não pode reconciliar o próprio orçamento', async () => {
    const pendente = await ledger.reserveDotExecution({ empresaId: EMP_A, plan: 'rei' });
    const res = await adminFetch('/api/dot/admin/budget/reconcile', {
      method: 'POST', token: tokenFor(USER_A, EMP_A), header: true,
      body: { reservation_id: pendente.reservation!.id, decision: 'settle', tokens: 1, reason: 'tentativa do proprietário' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'DOT_RECONCILE_PLATFORM_ADMIN_REQUIRED');
    assert.equal((await ledger.getDotReservation(EMP_A, pendente.reservation!.id))?.status, 'pending');
  });

  test('operador da plataforma liquida reserva ambígua e audita consumo real', async () => {
    const pendente = await ledger.reserveDotExecution({ empresaId: EMP_A, plan: 'rei' });
    const id = pendente.reservation!.id;
    const held = await ledger.finalizeDotReservation({
      empresaId: EMP_A, reservationId: id, ambiguous: true, ambiguousReason: 'resultado do provedor desconhecido',
    });
    assert.equal(held.ok, true);

    const res = await reconcileFetch({
      empresa_id: EMP_A, reservation_id: id, decision: 'settle', tokens: 700,
      provider: 'groq', reason: 'tokens confirmados no registro do provedor',
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.result.reservation.status, 'settled');
    assert.equal(Number((await ledger.getDotReservation(EMP_A, id))?.tokens_real), 700);
    const usage = await db.get(
      'SELECT COUNT(*) AS c, COALESCE(SUM(tokens),0) AS t FROM ai_usage WHERE empresa_id = ? AND feature = ?',
      [EMP_A, 'dot'],
    );
    assert.equal(Number(usage.c), 1);
    assert.equal(Number(usage.t), 700);
    const audit = await auditRows(EMP_A, 'dot.budget_reconciled');
    assert.ok(audit.some((row: any) => row.result === 'ok' && String(row.detail).includes('"decision":"settle"')));
  });

  test('operador não pode liquidar reserva não ambígua nem reserva em andamento', async () => {
    const pendente = await ledger.reserveDotExecution({ empresaId: EMP_A, plan: 'rei' });
    const id = pendente.reservation!.id;
    const res = await reconcileFetch({
      empresa_id: EMP_A, reservation_id: id, decision: 'settle', tokens: 1500,
      reason: 'tentativa de liquidar reserva ativa',
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'DOT_RECONCILE_REFUSED');
    assert.equal((await ledger.getDotReservation(EMP_A, id))?.status, 'pending');
  });

  test('settle com zero ou ausência de tokens é recusado', async () => {
    const sessao = await reconcileFetch({
      empresa_id: EMP_A, reservation_id: 1, decision: 'settle', tokens: 0,
      reason: 'zero tokens deve ser recusado',
    });
    assert.equal(sessao.status, 400);
    assert.equal(sessao.data.code, 'DOT_RECONCILE_BAD_TOKENS');
    const missing = await reconcileFetch({
      empresa_id: EMP_A, reservation_id: 1, decision: 'settle',
      reason: 'tokens ausentes devem ser recusados',
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.data.code, 'DOT_RECONCILE_BAD_TOKENS');
  });

  test('reconciliação exige X-Dot-Admin e identidade de operador da plataforma', async () => {
    const noHeader = await reconcileFetch({
      empresa_id: EMP_A, reservation_id: 1, decision: 'settle', tokens: 20,
      reason: 'cabeçalho ausente deve bloquear',
    }, { header: false });
    assert.equal(noHeader.status, 403);
    assert.equal(noHeader.data.code, 'DOT_ADMIN_HEADER_REQUIRED');

    const notAdmin = await reconcileFetch({
      empresa_id: EMP_A, reservation_id: 1, decision: 'settle', tokens: 20,
      reason: 'token de tenant deve bloquear',
    }, { token: tokenFor(USER_A, EMP_A) });
    assert.equal(notAdmin.status, 403);
    assert.equal(notAdmin.data.code, 'DOT_RECONCILE_PLATFORM_ADMIN_REQUIRED');
  });

  test('reserva enviada ao provedor nunca pode ser liberada por declaração do cliente', async () => {
    const pendente = await ledger.reserveDotExecution({ empresaId: EMP_A, plan: 'rei' });
    const id = pendente.reservation!.id;
    assert.equal((await ledger.markDotReservationSent({ empresaId: EMP_A, reservationId: id })).ok, true);
    assert.equal((await ledger.finalizeDotReservation({
      empresaId: EMP_A, reservationId: id, ambiguous: true, ambiguousReason: 'timeout após envio',
    })).ok, true);
    const res = await reconcileFetch({
      empresa_id: EMP_A, reservation_id: id, decision: 'release', confirm_not_sent: true,
      reason: 'declaração do cliente não prova ausência de envio',
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'DOT_RECONCILE_REFUSED');
    assert.equal((await ledger.getDotReservation(EMP_A, id))?.status, 'pending');
  });

  test('release só ocorre para ambiguidade comprovadamente não enviada', async () => {
    const pendente = await ledger.reserveDotExecution({ empresaId: EMP_A, plan: 'rei' });
    const id = pendente.reservation!.id;
    assert.equal((await ledger.finalizeDotReservation({
      empresaId: EMP_A, reservationId: id, ambiguous: true, ambiguousReason: 'ambiguidade antes do envio',
    })).ok, true);
    const missingConfirmation = await reconcileFetch({
      empresa_id: EMP_A, reservation_id: id, decision: 'release',
      reason: 'sem confirmação operacional explícita',
    });
    assert.equal(missingConfirmation.status, 400);
    assert.equal(missingConfirmation.data.code, 'DOT_RECONCILE_NOT_SENT_CONFIRMATION_REQUIRED');
    const before = await db.get('SELECT COUNT(*) AS c FROM ai_usage WHERE empresa_id = ?', [EMP_A]);
    const res = await reconcileFetch({
      empresa_id: EMP_A, reservation_id: id, decision: 'release', confirm_not_sent: true,
      reason: 'confirmado por evidência que não houve envio',
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.result.reservation.status, 'released');
    const after = await db.get('SELECT COUNT(*) AS c FROM ai_usage WHERE empresa_id = ?', [EMP_A]);
    assert.equal(Number(after.c), Number(before.c));
  });

  test('isolamento entre tenants continua aplicado na reconciliação de operador', async () => {
    const reservaB = await ledger.reserveDotExecution({ empresaId: EMP_B, plan: 'rei' });
    const id = reservaB.reservation!.id;
    const res = await reconcileFetch({
      empresa_id: EMP_A, reservation_id: id, decision: 'settle', tokens: 999,
      provider: 'groq', reason: 'tentativa de atingir outra empresa',
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'DOT_RECONCILE_REFUSED');
    assert.equal((await ledger.getDotReservation(EMP_B, id))?.status, 'pending');
    const usage = await db.get('SELECT COUNT(*) AS c FROM ai_usage WHERE empresa_id = ?', [EMP_B]);
    assert.equal(Number(usage.c), 0);
  });

  test('reconciliação HTTP lista metadados e liquida ledger sem reabrir a chave', async () => {
    const http = await import('../services/dotHttpIdempotency.js');
    const reservation = await ledger.reserveDotExecution({ empresaId: EMP_A, plan: 'rei' });
    assert.equal(reservation.ok, true);
    const claimResult = await http.claimDotHttpRequest({
      empresaId: EMP_A,
      endpoint: '/api/dot/chat',
      key: `http-ambiguous-${crypto.randomUUID()}`,
      payload: { message: 'conteúdo privado não deve aparecer', session_id: 'session-test' },
    });
    assert.equal(claimResult.kind, 'claimed');
    if (claimResult.kind !== 'claimed') throw new Error('claim expected');
    assert.equal(await http.attachDotHttpReservation(claimResult.claim, reservation.reservation!.id), true);
    assert.equal((await ledger.markDotReservationSent({ empresaId: EMP_A, reservationId: reservation.reservation!.id })).ok, true);
    assert.equal((await ledger.finalizeDotReservation({
      empresaId: EMP_A,
      reservationId: reservation.reservation!.id,
      ambiguous: true,
      ambiguousReason: 'timeout após envio',
    })).ok, true);
    await http.markDotHttpRequestAmbiguous(claimResult.claim);

    const queue = await adminFetch('/api/admin/dot/http-idempotency', { token: platformAdminToken() });
    assert.equal(queue.status, 200);
    const item = queue.data.records.find((record: any) => record.reservation_id === reservation.reservation!.id);
    assert.ok(item, 'tentativa ambígua vinculada deve aparecer na fila');
    assert.ok(!JSON.stringify(item).includes('conteúdo privado'));
    assert.ok(!JSON.stringify(item).includes(claimResult.claim.key));

    const reconciled = await adminFetch('/api/admin/dot/http-idempotency/reconcile', {
      method: 'POST',
      token: platformAdminToken(),
      header: true,
      body: {
        idempotency_id: item.id,
        decision: 'settle',
        tokens: 321,
        provider: 'groq',
        reason: 'uso confirmado no extrato operacional do provedor',
      },
    });
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.data));
    assert.equal(reconciled.data.idempotency_key_remains_blocked, true);
    assert.equal((await ledger.getDotReservation(EMP_A, reservation.reservation!.id))?.status, 'settled');
    const retry = await http.claimDotHttpRequest({
      empresaId: EMP_A,
      endpoint: '/api/dot/chat',
      key: claimResult.claim.key,
      payload: { message: 'conteúdo privado não deve aparecer', session_id: 'session-test' },
    });
    assert.equal(retry.kind, 'ambiguous', 'reconciliação financeira nunca reabre a chave HTTP');
  });


  test('falha ao persistir auditoria reverte a reconciliação financeira inteira', async () => {
    const http = await import('../services/dotHttpIdempotency.js');
    const reservation = await ledger.reserveDotExecution({ empresaId: EMP_A, plan: 'rei' });
    assert.equal(reservation.ok, true);
    const claim = await http.claimDotHttpRequest({
      empresaId: EMP_A,
      endpoint: '/api/dot/chat',
      key: `http-audit-failure-${crypto.randomUUID()}`,
      payload: { message: 'auditoria obrigatória', session_id: 'audit-failure' },
    });
    assert.equal(claim.kind, 'claimed');
    if (claim.kind !== 'claimed') throw new Error('claim expected');
    assert.equal(await http.attachDotHttpReservation(claim.claim, reservation.reservation!.id), true);
    assert.equal((await ledger.markDotReservationSent({ empresaId: EMP_A, reservationId: reservation.reservation!.id })).ok, true);
    assert.equal((await ledger.finalizeDotReservation({
      empresaId: EMP_A,
      reservationId: reservation.reservation!.id,
      ambiguous: true,
      ambiguousReason: 'timeout após envio',
    })).ok, true);
    await http.markDotHttpRequestAmbiguous(claim.claim);

    await db.exec(`
      CREATE TRIGGER fail_dot_reconcile_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'dot.http_idempotency_reconciled'
      BEGIN
        SELECT RAISE(ABORT, 'simulated audit persistence failure');
      END;
    `);
    try {
      const queue = await adminFetch('/api/admin/dot/http-idempotency', { token: platformAdminToken() });
      const item = queue.data.records.find((record: any) => record.reservation_id === reservation.reservation!.id);
      assert.ok(item);
      const response = await adminFetch('/api/admin/dot/http-idempotency/reconcile', {
        method: 'POST',
        token: platformAdminToken(),
        header: true,
        body: {
          idempotency_id: item.id,
          decision: 'settle',
          tokens: 456,
          provider: 'groq',
          reason: 'uso confirmado no extrato do provedor',
        },
      });
      assert.equal(response.status, 409);
      assert.equal(response.data.code, 'DOT_HTTP_RECONCILE_REFUSED');
      assert.equal((await ledger.getDotReservation(EMP_A, reservation.reservation!.id))?.status, 'pending');
      const usage = await db.get(
        'SELECT COUNT(*) AS c FROM ai_usage WHERE empresa_id = ? AND feature = ?',
        [EMP_A, 'dot'],
      );
      assert.equal(Number(usage.c), 1, 'o INSERT de consumo da tentativa revertida não pode persistir');
      const audit = await auditRows(EMP_A, 'dot.http_idempotency_reconciled');
      assert.equal(audit.length, 0, 'nenhuma auditoria persistida deve significar rollback total');
    } finally {
      await db.exec('DROP TRIGGER IF EXISTS fail_dot_reconcile_audit');
    }
  });


});
