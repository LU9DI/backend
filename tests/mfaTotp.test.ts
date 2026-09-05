import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { generateTotpSecret, verifyTotp, buildOtpauthUrl } from '../mfa.js';

/** Gera código TOTP atual a partir do secret (mesma lógica do módulo). */
function currentCode(secretBase32: string): string {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = secretBase32.replace(/=+$/, '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of cleaned) {
    const idx = B32.indexOf(c);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const secret = Buffer.from(out);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter & 0xffffffff, 4);
  const hmac = crypto.createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

describe('TOTP MFA', () => {
  it('gera secret base32', () => {
    const s = generateTotpSecret();
    assert.ok(s.length >= 16);
    assert.match(s, /^[A-Z2-7]+$/);
  });

  it('verifica código atual', () => {
    const secret = generateTotpSecret();
    const code = currentCode(secret);
    assert.equal(verifyTotp(secret, code), true);
  });

  it('rejeita código inválido', () => {
    const secret = generateTotpSecret();
    assert.equal(verifyTotp(secret, '000000'), false);
    assert.equal(verifyTotp(secret, 'abc'), false);
  });

  it('monta otpauth url', () => {
    const secret = generateTotpSecret();
    const url = buildOtpauthUrl({ secret, email: 'admin@test.com', issuer: 'Filtra.IA' });
    assert.ok(url.startsWith('otpauth://totp/'));
    assert.ok(url.includes(secret));
  });
});
