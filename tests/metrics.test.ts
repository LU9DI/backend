import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recordHttp, getHttpMetrics } from '../lib/metrics.js';

describe('HTTP metrics', () => {
  it('acumula amostras e calcula resumo', () => {
    recordHttp('GET', '/api/health', 200, 12);
    recordHttp('GET', '/api/health', 200, 20);
    recordHttp('GET', '/api/health', 500, 80);
    const m = getHttpMetrics();
    assert.ok(m.global.count >= 3);
    assert.ok(m.global.p50_ms != null);
    assert.ok(m.global.p95_ms != null);
    assert.ok(m.routes['GET /api/health']);
  });
});
