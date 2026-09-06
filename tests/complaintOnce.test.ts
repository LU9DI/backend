import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewFraudError } from '../lib/reviewFraud.js';

/**
 * Testa a lógica de “1 reclamação” de forma isolada (sem SQLite),
 * simulando o contrato de checkOneComplaintOnly.
 */
function shouldBlockSecondComplaint(opts: {
  rating: number;
  existingComplaintsByIp: number;
  existingComplaintsByWpp: number;
  hasWpp: boolean;
}): { block: boolean; reason?: string } {
  if (opts.rating > 3) return { block: false };
  if (opts.existingComplaintsByIp >= 1) {
    return { block: true, reason: 'ip' };
  }
  if (opts.hasWpp && opts.existingComplaintsByWpp >= 1) {
    return { block: true, reason: 'whatsapp' };
  }
  return { block: false };
}

describe('uma reclamação por dispositivo/WhatsApp', () => {
  it('permite primeira reclamação', () => {
    const r = shouldBlockSecondComplaint({
      rating: 2,
      existingComplaintsByIp: 0,
      existingComplaintsByWpp: 0,
      hasWpp: true,
    });
    assert.equal(r.block, false);
  });

  it('bloqueia segunda reclamação pelo mesmo IP', () => {
    const r = shouldBlockSecondComplaint({
      rating: 1,
      existingComplaintsByIp: 1,
      existingComplaintsByWpp: 0,
      hasWpp: true,
    });
    assert.equal(r.block, true);
    assert.equal(r.reason, 'ip');
  });

  it('bloqueia segunda reclamação pelo mesmo WhatsApp', () => {
    const r = shouldBlockSecondComplaint({
      rating: 3,
      existingComplaintsByIp: 0,
      existingComplaintsByWpp: 1,
      hasWpp: true,
    });
    assert.equal(r.block, true);
    assert.equal(r.reason, 'whatsapp');
  });

  it('notas positivas não entram na regra', () => {
    const r = shouldBlockSecondComplaint({
      rating: 5,
      existingComplaintsByIp: 5,
      existingComplaintsByWpp: 5,
      hasWpp: true,
    });
    assert.equal(r.block, false);
  });

  it('ReviewFraudError usa status 409 para conflito', () => {
    const e = new ReviewFraudError('já enviou', 409);
    assert.equal(e.status, 409);
    assert.equal(e.message, 'já enviou');
  });
});
