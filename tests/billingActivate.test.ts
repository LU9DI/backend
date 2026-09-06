/**
 * Testes unitários leves de regras de billing (sem Stripe real).
 */
import assert from 'assert';
import { resolvePlano, listPlanosPublicos, PLANOS } from '../stripeBilling.js';
import { planTemPdf, isTrialPlan } from '../lib/plans.js';
import { getTokenLimit, planTemIA } from '../lib/quota.js';
import { planPermiteUnidades } from '../lib/unidades.js';

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log('ok', name);
  } catch (e: any) {
    console.error('FAIL', name, e?.message || e);
    process.exitCode = 1;
  }
}

test('resolvePlano mensal e anual', () => {
  assert.equal(resolvePlano('pro')?.planDb, 'pro');
  assert.equal(resolvePlano('pro-anual')?.interval, 'year');
  assert.equal(resolvePlano('rei-anual')?.planDb, 'rei');
  assert.equal(resolvePlano('xyz'), null);
});

test('listPlanosPublicos tem 10 entradas', () => {
  const list = listPlanosPublicos();
  assert.equal(list.length, 10);
  assert.ok(list.every((p) => p.valueMonthly > 0));
});

test('PLANOS unitAmount coerente com display', () => {
  for (const k of Object.keys(PLANOS)) {
    const p = PLANOS[k];
    if (p.interval === 'month') {
      assert.equal(p.unitAmount, Math.round(p.displayMonthly * 100));
    }
  }
});

test('PDF e IA por plano', () => {
  assert.equal(planTemPdf('inicial'), false);
  assert.equal(planTemPdf('pro'), true);
  assert.equal(planTemPdf('trial'), true);
  assert.equal(planTemIA('inicial'), false);
  assert.equal(planTemIA('ultra'), true);
  assert.equal(isTrialPlan('teste'), true);
});

test('tokens e unidades', () => {
  assert.equal(getTokenLimit('pro'), 0);
  assert.ok(getTokenLimit('rei') > getTokenLimit('ultra'));
  assert.equal(planPermiteUnidades('corporativo'), true);
  assert.equal(planPermiteUnidades('pro'), false);
});

console.log('billingActivate.test done');
