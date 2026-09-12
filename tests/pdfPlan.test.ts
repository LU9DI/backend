import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planTemPdf } from '../lib/plans.js';

function pdfDepth(plan: string): 'none' | 'pro' | 'ultra' | 'corp' | 'rei' {
  const p = String(plan || '').toLowerCase();
  if (!planTemPdf(p)) return 'none';
  if (p === 'trial' || p === 'teste' || p === 'rei') return 'rei';
  if (p === 'corporativo' || p === 'corporate') return 'corp';
  if (p === 'ultra') return 'ultra';
  return 'pro';
}

describe('PDF por plano', () => {
  it('inicial não gera PDF', () => {
    assert.equal(pdfDepth('inicial'), 'none');
    assert.equal(planTemPdf('inicial'), false);
  });

  it('pro e trial são elegíveis', () => {
    assert.notEqual(pdfDepth('pro'), 'none');
    assert.notEqual(pdfDepth('trial'), 'none');
    assert.equal(pdfDepth('trial'), 'rei');
  });

  it('profundidade sobe com o plano', () => {
    assert.equal(pdfDepth('ultra'), 'ultra');
    assert.equal(pdfDepth('corporativo'), 'corp');
    assert.equal(pdfDepth('rei'), 'rei');
  });
});
