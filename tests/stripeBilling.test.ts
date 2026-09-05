import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlano, listPlanosPublicos, PLANOS, stripeConfigured } from '../stripeBilling.js';

describe('resolvePlano', () => {
  it('resolve todos os planos da tabela', () => {
    for (const key of Object.keys(PLANOS)) {
      const p = resolvePlano(key);
      assert.ok(p, `plano ${key}`);
      assert.equal(p!.key, key);
      assert.ok(p!.unitAmount > 0);
      assert.ok(p!.reviewLimit > 0);
    }
  });

  it('rejeita plano inválido', () => {
    assert.equal(resolvePlano('gold'), null);
    assert.equal(resolvePlano(''), null);
    assert.equal(resolvePlano('  '), null);
  });

  it('lista pública tem 10 entradas', () => {
    assert.equal(listPlanosPublicos().length, 10);
  });

  it('stripeConfigured sem chave é false', () => {
    const prev = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    assert.equal(stripeConfigured(), false);
    if (prev) process.env.STRIPE_SECRET_KEY = prev;
  });

  it('limites de feedback batem com o produto', () => {
    assert.equal(PLANOS.inicial.reviewLimit, 150);
    assert.equal(PLANOS.pro.reviewLimit, 400);
    assert.equal(PLANOS.ultra.reviewLimit, 800);
    assert.equal(PLANOS.corporativo.reviewLimit, 2500);
    assert.equal(PLANOS.rei.reviewLimit, 8000);
  });
});
