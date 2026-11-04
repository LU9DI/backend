import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlan, normalizePlanAlias, isPlanoOficial } from '../lib/plans.js';
import { getFeatureTokenLimit } from '../lib/quota.js';

test('normaliza aliases anuais sem inventar um plano', () => {
  assert.equal(normalizePlanAlias('corp-anual'), 'corporativo');
  assert.equal(normalizePlanAlias('corporate-anual'), 'corporativo');
  assert.equal(normalizePlanAlias('rei-anual'), 'rei');
  assert.equal(normalizePlan('corporativo-anual'), 'corporativo');
  assert.equal(normalizePlan('rei-anual'), 'rei');
});

test('plano ausente ou desconhecido permanece não identificado', () => {
  assert.equal(normalizePlan(null), null);
  assert.equal(normalizePlan(undefined), null);
  assert.equal(normalizePlan('plano-inventado'), null);
  assert.equal(isPlanoOficial('plano-inventado'), false);
});

test('cotas do Dot só existem para planos autorizados', () => {
  assert.equal(getFeatureTokenLimit('corporativo-anual', 'dot'), 200_000);
  assert.equal(getFeatureTokenLimit('rei-anual', 'dot'), 600_000);
  assert.equal(getFeatureTokenLimit(null, 'dot'), 0);
  assert.equal(getFeatureTokenLimit('plano-inventado', 'dot'), 0);
});
