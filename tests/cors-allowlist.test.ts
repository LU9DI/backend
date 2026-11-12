import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCorsOptions } from '../lib/cors.js';

test('allows the exact production frontend origins and rejects unknown origins', async () => {
  const saved = {
    nodeEnv: process.env.NODE_ENV,
    cors: process.env.CORS_ORIGINS,
    app: process.env.APP_URL,
    frontend: process.env.FRONTEND_URL,
  };
  try {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGINS = '';
    delete process.env.APP_URL;
    delete process.env.FRONTEND_URL;

    const origin = buildCorsOptions().origin as unknown as (
      value: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => void;
    const check = (value: string) => new Promise<{ error: Error | null; allowed?: boolean }>((resolve) => {
      origin(value, (error, allowed) => resolve({ error, allowed }));
    });

    for (const value of [
      'https://filtra-ai-web-cloud.onrender.com',
      'https://filtra-ai-web-runtime.onrender.com',
      'https://filtraai.com',
      'https://www.filtraai.com',
    ]) {
      const result = await check(value);
      assert.equal(result.error, null, value);
      assert.equal(result.allowed, true, value);
    }

    const denied = await check('https://unknown-preview.example');
    assert.equal(denied.error, null);
    assert.equal(denied.allowed, false);
  } finally {
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.nodeEnv;
    if (saved.cors === undefined) delete process.env.CORS_ORIGINS; else process.env.CORS_ORIGINS = saved.cors;
    if (saved.app === undefined) delete process.env.APP_URL; else process.env.APP_URL = saved.app;
    if (saved.frontend === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = saved.frontend;
  }
});
