import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { empresaInformadaPertenceAoToken, isAdminUser, isPlatformAdminPrincipal, signAccessToken } from '../lib/auth.js';

const originalAdminEmail = process.env.ADMIN_EMAIL;
const originalJwtSecret = process.env.JWT_SECRET;

afterEach(() => {
  if (originalAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
  else process.env.ADMIN_EMAIL = originalAdminEmail;
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
});

test('legacy role=admin never grants platform privileges to a tenant principal', () => {
  process.env.ADMIN_EMAIL = 'platform@example.test';
  const legacy = { id: 'tenant-user', empresa_id: 'tenant-a', role: 'admin' };
  assert.equal(isPlatformAdminPrincipal(legacy), false);
  assert.equal(isAdminUser(legacy), false);
});

test('platform admin claim is accepted only when explicitly present in signed principal', () => {
  process.env.ADMIN_EMAIL = 'platform@example.test';
  const principal = { id: 'tenant-user', empresa_id: 'tenant-a', platform_admin: true };
  assert.equal(isPlatformAdminPrincipal(principal), true);
  assert.equal(isAdminUser(principal), true);
});

test('reserved platform tenant remains an admin identity', () => {
  process.env.ADMIN_EMAIL = 'platform@example.test';
  assert.equal(isPlatformAdminPrincipal({ empresa_id: 'admin', role: 'empresa' }), true);
});

test('configured platform administrator email is recognized for database-backed checks', () => {
  process.env.ADMIN_EMAIL = 'platform@example.test';
  assert.equal(isAdminUser({ empresa_id: 'legacy-admin-tenant', email: 'PLATFORM@example.test' }), true);
  assert.equal(isAdminUser({ empresa_id: 'tenant-a', email: 'user@example.test', role: 'admin' }), false);
});

test('signed legacy role=admin token cannot cross tenant boundary', () => {
  process.env.ADMIN_EMAIL = 'platform@example.test';
  process.env.JWT_SECRET = 'auth-platform-admin-regression-secret-123456';
  const token = signAccessToken({
    id: 'tenant-user',
    nome_funcionario: 'Tenant User',
    empresa_id: 'tenant-a',
    role: 'admin',
  });
  const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} } as any;
  assert.equal(empresaInformadaPertenceAoToken(req, 'tenant-a'), true);
  assert.equal(empresaInformadaPertenceAoToken(req, 'tenant-b'), false);
});

test('signed platform_admin claim can access a different tenant', () => {
  process.env.ADMIN_EMAIL = 'platform@example.test';
  process.env.JWT_SECRET = 'auth-platform-admin-regression-secret-123456';
  const token = signAccessToken({
    id: 'platform-admin',
    nome_funcionario: 'Platform Admin',
    empresa_id: 'tenant-a',
    role: 'admin',
    platform_admin: true,
  });
  const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} } as any;
  assert.equal(empresaInformadaPertenceAoToken(req, 'tenant-b'), true);
});
