import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { validateEnv } from '../lib/env.js';

describe('validateEnv', () => {
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ['JWT_SECRET', 'STRIPE_SECRET_KEY', 'ADMIN_RECOVERY_SECRET', 'GROQ_API_KEY', 'SMTP_HOST']) {
      prev[k] = process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('falha sem JWT_SECRET', () => {
    delete process.env.JWT_SECRET;
    const r = validateEnv();
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('JWT_SECRET')));
  });

  it('ok com JWT longo', () => {
    process.env.JWT_SECRET = 'x'.repeat(32);
    delete process.env.STRIPE_SECRET_KEY;
    const r = validateEnv();
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => w.includes('STRIPE')));
  });
});
