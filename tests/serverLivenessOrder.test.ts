/**
 * Render liveness must bypass every application middleware. A regression once
 * moved this route below request ID, metrics, JSON parsing and CORS, defeating
 * the intended DB-free/minimal health check during middleware failures.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

test('GET /api/live is registered before application middleware', () => {
  const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const liveRoute = source.indexOf("app.get('/api/live'");
  const firstMiddleware = source.indexOf('app.use(requestIdMiddleware)');

  assert.notEqual(liveRoute, -1, 'the liveness route must exist');
  assert.notEqual(firstMiddleware, -1, 'the request middleware must exist');
  assert.ok(
    liveRoute < firstMiddleware,
    'Render liveness must be registered before request ID, metrics, parsers, CORS and other middleware',
  );
});
