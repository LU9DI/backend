/**
 * Smoke de integração — valida módulos críticos.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('smoke — módulos críticos exportam', () => {
  it('validateEnv rejeita JWT curto', async () => {
    const prev = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'curto';
    const { validateEnv } = await import('../lib/env.js');
    const r = validateEnv();
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('JWT_SECRET')));
    if (prev === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prev;
  });

  it('plan utils e planTemRelatorio', async () => {
    const { planTemRelatorio, isPlanoOficial, allowPlanSwitch } = await import('../lib/plans.js');
    assert.equal(isPlanoOficial('rei'), true);
    assert.equal(isPlanoOficial('gold'), false);
    assert.equal(planTemRelatorio('inicial'), false);
    assert.equal(typeof allowPlanSwitch(), 'boolean');
  });

  it('password policy', async () => {
    const { validarSenhaEmpresa } = await import('../lib/passwordPolicy.js');
    assert.equal(validarSenhaEmpresa('abc').ok, false);
    assert.equal(validarSenhaEmpresa('Abcdef1!').ok, true);
  });

  it('jwt sign/verify com secret de teste', async () => {
    process.env.JWT_SECRET = 'secret-de-teste-com-mais-de-32-chars!!';
    delete process.env.JWT_SECRET_PREVIOUS;
    const { signAccessToken, verifyAccessToken } = await import('../lib/jwtKeys.js');
    const t = signAccessToken({
      id: '1',
      nome_funcionario: 'T',
      empresa_id: 'e',
    });
    const p = verifyAccessToken(t);
    assert.equal(p.id, '1');
  });
});
