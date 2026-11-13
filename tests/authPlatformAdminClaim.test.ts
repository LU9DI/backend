import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { isAdminUser, isPlatformAdminPrincipal } from '../lib/auth.js';

const originalAdminEmail = process.env.ADMIN_EMAIL;

afterEach(() => {
  if (originalAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
  else process.env.ADMIN_EMAIL = originalAdminEmail;
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
