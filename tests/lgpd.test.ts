import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/** Pure helpers mirror — retention defaults */
function retentionDaysFromEnv(env: Record<string, string | undefined>): number {
  const n = Number(env.LGPD_WHATSAPP_RETENTION_DAYS || 90);
  return Number.isFinite(n) && n > 0 ? n : 90;
}

describe('lgpd retention', () => {
  it('default 90 days', () => {
    assert.equal(retentionDaysFromEnv({}), 90);
  });
  it('respects env', () => {
    assert.equal(retentionDaysFromEnv({ LGPD_WHATSAPP_RETENTION_DAYS: '30' }), 30);
  });
  it('invalid falls back', () => {
    assert.equal(retentionDaysFromEnv({ LGPD_WHATSAPP_RETENTION_DAYS: 'x' }), 90);
  });
});
