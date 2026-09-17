import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planTemPdf } from '../lib/plans.js';

/** Mapa de profundidade do PDF (espelha relatorioPdf.ts) */
function pdfDepth(plan: string): 'none' | 'pro' | 'ultra' | 'corp' | 'rei' {
  const p = String(plan || '').toLowerCase();
  if (!planTemPdf(p)) return 'none';
  if (p === 'rei') return 'rei';
  if (p === 'corporativo') return 'corp';
  if (p === 'ultra') return 'ultra';
  // trial usa a profundidade Ultra; os demais planos elegíveis usam Pro como base
  return p === 'trial' || p === 'teste' || p === 'test' ? 'ultra' : 'pro';
}

describe('PDF por plano', () => {
  it('inicial não gera PDF', () => {
    assert.equal(pdfDepth('inicial'), 'none');
    assert.equal(planTemPdf('inicial'), false);
  });

  it('pro e trial elegíveis', () => {
    assert.notEqual(pdfDepth('pro'), 'none');
    assert.notEqual(pdfDepth('trial'), 'none');
  });

  it('profundidade sobe com o plano', () => {
    assert.equal(pdfDepth('ultra'), 'ultra');
    assert.equal(pdfDepth('corporativo'), 'corp');
    assert.equal(pdfDepth('rei'), 'rei');
  });
});
