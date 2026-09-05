import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('JWT rotation', () => {
  const prevEnv: Record<string, string | undefined> = {};

  before(() => {
    for (const k of ['JWT_SECRET', 'JWT_SECRET_PREVIOUS', 'JWT_KID', 'JWT_EXPIRES']) {
      prevEnv[k] = process.env[k];
    }
    process.env.JWT_SECRET = 'secret-atual-super-longo-teste-123456';
    process.env.JWT_SECRET_PREVIOUS = 'secret-antigo-super-longo-teste-123456';
    process.env.JWT_KID = 'v2';
    process.env.JWT_EXPIRES = '1h';
  });

  after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('assina com chave atual e verifica com atual', async () => {
    const { signAccessToken, verifyAccessToken, listVerifySecrets } = await import(
      '../lib/jwtKeys.js'
    );
    assert.equal(listVerifySecrets().length, 2);
    const token = signAccessToken({
      id: 'u1',
      nome_funcionario: 'Teste',
      empresa_id: 'e1',
    });
    const payload = verifyAccessToken(token);
    assert.equal(payload.id, 'u1');
    assert.equal(payload.kid, 'v2');
  });

  it('ainda valida token assinado com chave anterior', async () => {
    const jwt = await import('jsonwebtoken');
    const { verifyAccessToken } = await import('../lib/jwtKeys.js');
    const oldToken = jwt.default.sign(
      { id: 'u2', nome_funcionario: 'Old', empresa_id: 'e2', kid: 'v1' },
      process.env.JWT_SECRET_PREVIOUS!,
      { expiresIn: '1h' }
    );
    const payload = verifyAccessToken(oldToken);
    assert.equal(payload.id, 'u2');
  });
});
