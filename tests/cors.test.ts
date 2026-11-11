import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCorsOptions } from '../lib/cors.js';

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { run(); } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('allows configured production origins', () => {
  withEnv({
    NODE_ENV: 'production',
    CORS_ORIGINS: 'https://filtraai.com,https://www.filtraai.com',
    APP_URL: undefined,
    FRONTEND_URL: undefined,
  }, () => {
    const options = buildCorsOptions();
    assert.equal(typeof options.origin, 'function');
    const resolve = options.origin as (origin: string, callback: (error: Error | null, allowed?: boolean) => void) => void;
    resolve('https://filtraai.com', (error, allowed) => {
      assert.equal(error, null);
      assert.equal(allowed, true);
    });
  });
});

test('denies unconfigured production origins without raising an internal error', () => {
  withEnv({
    NODE_ENV: 'production',
    CORS_ORIGINS: 'https://filtraai.com',
    APP_URL: undefined,
    FRONTEND_URL: undefined,
  }, () => {
    const options = buildCorsOptions();
    const resolve = options.origin as (origin: string, callback: (error: Error | null, allowed?: boolean) => void) => void;
    resolve('http://127.0.0.1:3000', (error, allowed) => {
      assert.equal(error, null);
      assert.equal(allowed, false);
    });
  });
});

test('allows requests without Origin for health checks and server-to-server calls', () => {
  withEnv({
    NODE_ENV: 'production',
    CORS_ORIGINS: 'https://filtraai.com',
    APP_URL: undefined,
    FRONTEND_URL: undefined,
  }, () => {
    const options = buildCorsOptions();
    const resolve = options.origin as (origin: undefined, callback: (error: Error | null, allowed?: boolean) => void) => void;
    resolve(undefined, (error, allowed) => {
      assert.equal(error, null);
      assert.equal(allowed, true);
    });
  });
});
