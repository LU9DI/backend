import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getFeedbackLimit,
  getTokenLimit,
  planTemIA,
  PLAN_FEEDBACK_LIMITS,
  PLAN_TOKEN_LIMITS,
} from '../lib/quota.js';
import { planTemPdf, isTrialPlan } from '../lib/plans.js';

describe('planTemIA', () => {
  it('inicial e pro sem IA', () => {
    assert.equal(planTemIA('inicial'), false);
    assert.equal(planTemIA('pro'), false);
  });
  it('ultra+ e trial com IA', () => {
    assert.equal(planTemIA('ultra'), true);
    assert.equal(planTemIA('corporativo'), true);
    assert.equal(planTemIA('rei'), true);
    assert.equal(planTemIA('trial'), true);
  });
});

describe('getFeedbackLimit', () => {
  it('respeita tabela de planos', () => {
    assert.equal(getFeedbackLimit('trial'), PLAN_FEEDBACK_LIMITS.trial);
    assert.equal(getFeedbackLimit('inicial'), PLAN_FEEDBACK_LIMITS.inicial);
    assert.equal(getFeedbackLimit('pro'), PLAN_FEEDBACK_LIMITS.pro);
    assert.equal(getFeedbackLimit('ultra'), PLAN_FEEDBACK_LIMITS.ultra);
    assert.equal(getFeedbackLimit('rei'), PLAN_FEEDBACK_LIMITS.rei);
  });
  it('fallback trial para plano desconhecido', () => {
    assert.equal(getFeedbackLimit('xyz'), PLAN_FEEDBACK_LIMITS.trial);
  });
});

describe('getTokenLimit', () => {
  it('inicial/pro zerados', () => {
    assert.equal(getTokenLimit('inicial'), 0);
    assert.equal(getTokenLimit('pro'), 0);
  });
  it('trial e ultra+ com teto', () => {
    assert.ok(getTokenLimit('trial') > 0);
    assert.ok(getTokenLimit('ultra') > getTokenLimit('trial'));
    assert.ok(getTokenLimit('rei') >= getTokenLimit('corporativo'));
    assert.equal(getTokenLimit('ultra'), PLAN_TOKEN_LIMITS.ultra);
  });
});

describe('planTemPdf', () => {
  it('inicial sem PDF; pro+ e trial com PDF', () => {
    assert.equal(planTemPdf('inicial'), false);
    assert.equal(planTemPdf('pro'), true);
    assert.equal(planTemPdf('ultra'), true);
    assert.equal(planTemPdf('corporativo'), true);
    assert.equal(planTemPdf('rei'), true);
    assert.equal(planTemPdf('trial'), true);
    assert.equal(isTrialPlan('teste'), true);
  });
});
