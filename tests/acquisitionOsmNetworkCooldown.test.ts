import assert from 'node:assert/strict';
import test from 'node:test';
import { __test, getOsmEndpointState, resetOsmEndpointState } from '../lib/acquisitionReplenisher.js';

test('OSM circuit breaker classifies transient network failures for cooldown', () => {
  for (const reason of [
    'fetch failed',
    'TypeError: fetch failed',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'timeout',
    'HTTP 429',
    'HTTP 503',
  ]) {
    assert.equal(__test.shouldCooldownOsmEndpoint(reason), true, reason);
  }
});

test('OSM circuit breaker does not cooldown deterministic client errors', () => {
  for (const reason of ['HTTP 400', 'HTTP 401', 'HTTP 403', 'invalid query']) {
    assert.equal(__test.shouldCooldownOsmEndpoint(reason), false, reason);
  }
});

test('OSM network failure enters cooldown and prevents immediate retry', () => {
  resetOsmEndpointState();
  const endpoint = 'https://overpass-api.de/api/interpreter';
  assert.equal(__test.osmEndpointAvailable(endpoint, 1_000_000), true);
  if (__test.shouldCooldownOsmEndpoint('fetch failed')) {
    __test.markOsmEndpointFailure(endpoint, 'fetch failed', 1_000_000);
  }
  assert.equal(__test.osmEndpointAvailable(endpoint, 1_000_001), false);
  assert.equal(getOsmEndpointState(1_000_001)[endpoint].reason, 'fetch failed');
  resetOsmEndpointState();
});
