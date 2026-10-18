/**
 * PIN administrativo do Dot e sessão exclusiva (nível de serviço).
 *
 * Cobre: formato/força do PIN, hash scrypt (salt individual, nunca em claro),
 * primeiro cadastro, redefinição com senha, atraso progressivo e bloqueio
 * temporário persistidos no banco (multi-instância), expiração, revogação,
 * versão do PIN e vínculo empresa+usuário da sessão.
 */
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDb = path.join(os.tmpdir(), `filtra-dot-pin-${Date.now()}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.SQLITE_DB_PATH = tmpDb;

const SENHA_OWNER = 'SenhaForte-12345';

let getDb: any;
let security: typeof import('../services/dotAdminSecurity.js');

async function seedEmpresa(id: string) {
  await getDb().run(
    'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
    [
      id,
      'cnpj-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14),
      'Empresa PIN',
      'slug-' + id.slice(0, 8),
      'ativo',
      'rei',
      new Date().toISOString(),
      new Date(Date.now() + 30 * 86400000).toISOString(),
    ],
  );
}

async function seedUsuario(empresaId: string, senha = SENHA_OWNER): Promise<string> {
  const id = crypto.randomUUID();
  const hash = await bcrypt.hash(senha, 4);
  await getDb().run(
    'INSERT INTO usuarios (id, cnpj, nome_funcionario, empresa_id, senha_hash) VALUES (?,?,?,?,?)',
    [id, '00000000000000', 'Dono Teste', empresaId, hash],
  );
  return id;
}

function fakeReq(cookie?: string): any {
  return { cookies: cookie ? { dot_admin_session: cookie } : {}, headers: {} };
}

before(async () => {
  const dbMod = await import('../lib/db.js');
  security = await import('../services/dotAdminSecurity.js');
  await dbMod.initDB();
  await security.ensureDotAdminSecuritySchema();
  getDb = dbMod.getDb;
});

after(() => {
  try {
    fs.unlinkSync(tmpDb);
  } catch {
    /* ok */
  }
});

describe('PIN administrativo: formato e hash', () => {
  it('rejeita formatos fracos e aceita 6 dígitos sem padrão óbvio', () => {
    assert.ok(security.validateDotPinFormat('12345'));
    assert.ok(security.validateDotPinFormat('1234567'));
    assert.ok(security.validateDotPinFormat('12a456'));
    assert.ok(security.validateDotPinFormat('000000'));
    assert.ok(security.validateDotPinFormat('999999'));
    assert.ok(security.validateDotPinFormat('123456'));
    assert.ok(security.validateDotPinFormat('654321'));
    assert.equal(security.validateDotPinFormat('482915'), null);
    assert.equal(security.validateDotPinFormat('807261'), null);
  });

  it('armazena apenas hash scrypt com salt individual e compara sem vazar o PIN', async () => {
    const hash1 = await security.hashDotPin('482915');
    const hash2 = await security.hashDotPin('482915');
    assert.match(hash1, /^scrypt\$/);
    assert.notEqual(hash1, hash2, 'salt individual por registro');
    assert.ok(!hash1.includes('482915'), 'o PIN nunca aparece no material guardado');

    assert.equal(await security.verifyDotPinHash(hash1, '482915'), true);
    assert.equal(await security.verifyDotPinHash(hash1, '482916'), false);
    assert.equal(await security.verifyDotPinHash('scrypt$abc', '482915'), false, 'hash corrompido nunca passa');
    assert.equal(await security.verifyDotPinHash('', '482915'), false);
  });
});

describe('PIN administrativo: cadastro, redefinição e bloqueio', () => {
  it('primeiro cadastro é único; redefinição exige senha e sobe a versão', async () => {
    const empresa = crypto.randomUUID();
    await seedEmpresa(empresa);
    const owner = await seedUsuario(empresa);

    assert.equal((await security.getDotAdminPinState(empresa)).configured, false);
    const created = await security.setDotAdminPinInitial(empresa, owner, '482915');
    assert.equal(created.version, 1);
    assert.equal((await security.getDotAdminPinState(empresa)).configured, true);

    await assert.rejects(
      () => security.setDotAdminPinInitial(empresa, owner, '807261'),
      /já está configurado/,
    );

    await assert.rejects(
      () => security.resetDotAdminPin(empresa, owner, '807261', 'senha-errada'),
      /Senha atual incorreta/,
    );

    const reset = await security.resetDotAdminPin(empresa, owner, '807261', SENHA_OWNER);
    assert.equal(reset.version, 2);

    // O PIN antigo não funciona mais; o novo sim.
    await assert.rejects(
      () => security.verifyDotAdminPinForSession(empresa, owner, '482915'),
      /PIN incorreto/,
    );
    // Limpa o atraso progressivo da tentativa acima (só para o teste seguir).
    await getDb().run(
      'UPDATE dot_admin_pin_attempts SET failed_count = 0, lock_until = NULL WHERE empresa_id = ? AND user_id = ?',
      [empresa, owner],
    );
    const session = await security.verifyDotAdminPinForSession(empresa, owner, '807261');
    assert.ok(session.token.length >= 40);
  });

  it('redefinir o PIN invalida as sessões anteriores (versão)', async () => {
    const empresa = crypto.randomUUID();
    await seedEmpresa(empresa);
    const owner = await seedUsuario(empresa);
    await security.setDotAdminPinInitial(empresa, owner, '482915');

    const session = await security.verifyDotAdminPinForSession(empresa, owner, '482915');
    const active = await security.getActiveDotAdminSession(fakeReq(session.token), empresa, owner);
    assert.ok(active, 'sessão recém-emitida é válida');

    await security.resetDotAdminPin(empresa, owner, '807261', SENHA_OWNER);
    const afterReset = await security.getActiveDotAdminSession(fakeReq(session.token), empresa, owner);
    assert.equal(afterReset, null, 'sessão da versão anterior do PIN não vale mais');
  });

  it('atraso progressivo e bloqueio temporário persistem no banco e expiram', async () => {
    const empresa = crypto.randomUUID();
    await seedEmpresa(empresa);
    const owner = await seedUsuario(empresa);
    await security.setDotAdminPinInitial(empresa, owner, '482915');

    // Primeiras falhas: atraso progressivo (403) com retry_after_ms.
    const first = await security
      .verifyDotAdminPinForSession(empresa, owner, '000001')
      .then(() => null)
      .catch((e) => e);
    assert.ok(first);
    assert.equal(first.status, 403);
    assert.equal(first.code, 'DOT_ADMIN_PIN_INVALID');
    assert.ok(Number(first.retryAfterMs) > 0);

    // A linha de tentativas fica no banco (sobrevive a reinício de instância).
    const row = await getDb().get(
      'SELECT failed_count, lock_until FROM dot_admin_pin_attempts WHERE empresa_id = ? AND user_id = ?',
      [empresa, owner],
    );
    assert.equal(Number(row.failed_count), 1);
    assert.ok(row.lock_until);

    // Antes do bloqueio longo, o atraso progressivo barra novas tentativas.
    const tooSoon = await security
      .verifyDotAdminPinForSession(empresa, owner, '482915')
      .then(() => null)
      .catch((e) => e);
    assert.ok(tooSoon, 'tentativa durante o atraso é recusada mesmo com PIN correto');
    assert.equal(tooSoon.status, 429);

    // Atraso vencido: o contador CONTINUA de onde parou (escalada real).
    await getDb().run(
      'UPDATE dot_admin_pin_attempts SET lock_until = ? WHERE empresa_id = ? AND user_id = ?',
      [new Date(Date.now() - 1000).toISOString(), empresa, owner],
    );
    const second = await security
      .verifyDotAdminPinForSession(empresa, owner, '000002')
      .then(() => null)
      .catch((e) => e);
    assert.ok(second);
    assert.equal(second.status, 403, 'atraso vencido não zera o contador');
    const row2 = await getDb().get(
      'SELECT failed_count FROM dot_admin_pin_attempts WHERE empresa_id = ? AND user_id = ?',
      [empresa, owner],
    );
    assert.equal(Number(row2.failed_count), 2);

    // Falhas 3 e 4 seguem com atraso; a 5ª dispara o bloqueio temporário.
    let lastError: any = null;
    for (let failure = 3; failure <= 5; failure += 1) {
      await getDb().run(
        'UPDATE dot_admin_pin_attempts SET lock_until = ? WHERE empresa_id = ? AND user_id = ?',
        [new Date(Date.now() - 1000).toISOString(), empresa, owner],
      );
      lastError = await security
        .verifyDotAdminPinForSession(empresa, owner, `00000${failure}`)
        .then(() => null)
        .catch((e) => e);
    }
    assert.ok(lastError);
    assert.equal(lastError.status, 429, 'a quinta falha dispara bloqueio temporário');
    assert.equal(lastError.code, 'DOT_ADMIN_LOCKED');
    assert.ok(Number(lastError.retryAfterMs) >= 10 * 60 * 1000 - 5000, 'bloqueio de pelo menos ~10min');

    // Durante o bloqueio nem o PIN correto passa.
    const locked = await security
      .verifyDotAdminPinForSession(empresa, owner, '482915')
      .then(() => null)
      .catch((e) => e);
    assert.ok(locked);
    assert.equal(locked.status, 429);

    // Bloqueio NUNCA é permanente: vencido, o PIN correto volta a valer e o
    // contador zera (nova janela de tentativas).
    await getDb().run(
      'UPDATE dot_admin_pin_attempts SET lock_until = ? WHERE empresa_id = ? AND user_id = ?',
      [new Date(Date.now() - 1000).toISOString(), empresa, owner],
    );
    const unlocked = await security.verifyDotAdminPinForSession(empresa, owner, '482915');
    assert.ok(unlocked.token);
    const cleared = await getDb().get(
      'SELECT failed_count, lock_until FROM dot_admin_pin_attempts WHERE empresa_id = ? AND user_id = ?',
      [empresa, owner],
    );
    assert.equal(Number(cleared.failed_count), 0);
    assert.equal(cleared.lock_until, null);
  });

  it('a auditoria registra falhas sem nunca conter o PIN', async () => {
    const empresa = crypto.randomUUID();
    await seedEmpresa(empresa);
    const owner = await seedUsuario(empresa);
    await security.setDotAdminPinInitial(empresa, owner, '482915');
    await security.verifyDotAdminPinForSession(empresa, owner, '777777').catch(() => null);

    const audits = await getDb().all(
      'SELECT action, detail, result FROM audit_logs WHERE empresa_id = ? ORDER BY id ASC',
      [empresa],
    );
    assert.ok(audits.some((row: any) => row.action === 'dot.pin_set'));
    assert.ok(audits.some((row: any) => row.action === 'dot.pin_verify_failed'));
    const serialized = JSON.stringify(audits);
    assert.ok(!serialized.includes('482915'), 'PIN configurado nunca aparece na auditoria');
    assert.ok(!serialized.includes('777777'), 'PIN tentado nunca aparece na auditoria');
    // O material guardado no banco também não contém o PIN.
    const pinRow = await getDb().get('SELECT pin_hash FROM dot_admin_pins WHERE empresa_id = ?', [empresa]);
    assert.ok(!String(pinRow.pin_hash).includes('482915'));
  });
});

describe('Sessão administrativa: vínculo, expiração e revogação', () => {
  async function setupEmpresaComPin() {
    const empresa = crypto.randomUUID();
    await seedEmpresa(empresa);
    const owner = await seedUsuario(empresa);
    await security.setDotAdminPinInitial(empresa, owner, '482915');
    return { empresa, owner };
  }

  it('sessão é vinculada à empresa e ao usuário (não vale em outro escopo)', async () => {
    const a = await setupEmpresaComPin();
    const b = await setupEmpresaComPin();
    const session = await security.verifyDotAdminPinForSession(a.empresa, a.owner, '482915');

    assert.ok(await security.getActiveDotAdminSession(fakeReq(session.token), a.empresa, a.owner));
    assert.equal(
      await security.getActiveDotAdminSession(fakeReq(session.token), b.empresa, b.owner),
      null,
      'sessão da empresa A não vale para a empresa B',
    );
    assert.equal(
      await security.getActiveDotAdminSession(fakeReq(session.token), a.empresa, 'outro-usuario'),
      null,
      'sessão não pode trocar de usuário',
    );
    assert.equal(await security.getActiveDotAdminSession(fakeReq('token-forjado'), a.empresa, a.owner), null);
    assert.equal(await security.getActiveDotAdminSession(fakeReq(), a.empresa, a.owner), null);
  });

  it('expiração e revogação invalidam a sessão', async () => {
    const { empresa, owner } = await setupEmpresaComPin();
    const session = await security.verifyDotAdminPinForSession(empresa, owner, '482915');

    // Expiração
    await getDb().run('UPDATE dot_admin_sessions SET expires_at = ? WHERE id = ?', [
      new Date(Date.now() - 1000).toISOString(),
      session.id,
    ]);
    assert.equal(await security.getActiveDotAdminSession(fakeReq(session.token), empresa, owner), null);

    // Revogação explícita
    const session2 = await security.verifyDotAdminPinForSession(empresa, owner, '482915');
    assert.equal(await security.revokeDotAdminSessionByToken(session2.token, 'lock'), true);
    assert.equal(await security.getActiveDotAdminSession(fakeReq(session2.token), empresa, owner), null);
    // Revogar de novo é idempotente e não acha nada.
    assert.equal(await security.revokeDotAdminSessionByToken(session2.token, 'lock'), false);
  });

  it('requireDotAdminSession exige cabeçalho e sessão válida (falha fechada)', async () => {
    const { empresa, owner } = await setupEmpresaComPin();

    await assert.rejects(
      () => security.requireDotAdminSession(fakeReq(), empresa, owner),
      /X-Dot-Admin/,
    );

    const session = await security.verifyDotAdminPinForSession(empresa, owner, '482915');
    const req: any = fakeReq(session.token);
    req.headers = { 'x-dot-admin': '1' };
    const active = await security.requireDotAdminSession(req, empresa, owner);
    assert.equal(active.id, session.id);

    // Sem sessão (mesmo com cabeçalho) → negado.
    const reqNoCookie: any = fakeReq();
    reqNoCookie.headers = { 'x-dot-admin': '1' };
    await assert.rejects(
      () => security.requireDotAdminSession(reqNoCookie, empresa, owner),
      /PIN administrativo/,
    );

    // Escopo errado → negado.
    const reqCross: any = fakeReq(session.token);
    reqCross.headers = { 'x-dot-admin': '1' };
    await assert.rejects(
      () => security.requireDotAdminSession(reqCross, empresa, 'outro-usuario'),
      /PIN administrativo/,
    );
  });
});
