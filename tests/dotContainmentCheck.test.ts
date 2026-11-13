import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateContainment, type ProbeResult } from '../lib/dotContainmentCheck.js';

const OK_LIVE: ProbeResult = { status: 200, body: { ok: true, live: true } };
const OK_HEALTH: ProbeResult = { status: 200, body: { ok: true, db_ok: true } };

function enabledStatus(): ProbeResult {
  return {
    status: 200,
    body: {
      ok: true,
      enabled: false,
      access: false,
      scheduler: { timer_active: true, tick_ms: 300000 },
      worker: { timer_active: true, running: false },
    },
  };
}

function disabledStatus(): ProbeResult {
  return {
    status: 403,
    body: {
      ok: false,
      enabled: false,
      access: false,
      error: 'Filtra Dot desativado. Defina FILTRA_DOT_ENABLED=1 para habilitar.',
    },
  };
}

const PREFERENCES_403: ProbeResult = { status: 403, body: { ok: false, error: 'Autenticação necessária.' } };
const PREFERENCES_404: ProbeResult = { status: 404, body: { error: 'Rota não encontrada.' } };

test('estado habilitado corresponde quando scheduler e worker têm timer ativo', () => {
  const verdict = evaluateContainment({
    live: OK_LIVE,
    health: OK_HEALTH,
    status: enabledStatus(),
    preferences: PREFERENCES_403,
    expect: 'enabled',
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.summary.scheduler_timer_active, true);
  assert.equal(verdict.summary.worker_timer_active, true);
});

test('estado habilitado reprova quando o scheduler está inerte', () => {
  const status = enabledStatus();
  (status.body as Record<string, unknown>).scheduler = { timer_active: false };
  const verdict = evaluateContainment({
    live: OK_LIVE,
    health: OK_HEALTH,
    status,
    preferences: PREFERENCES_403,
    expect: 'enabled',
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.includes('scheduler.timer_active')));
});

test('estado desabilitado corresponde com tombstone 403 e rotas ausentes', () => {
  const verdict = evaluateContainment({
    live: OK_LIVE,
    health: OK_HEALTH,
    status: disabledStatus(),
    preferences: PREFERENCES_404,
    expect: 'disabled',
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.summary.dot_status_status, 403);
});

test('estado desabilitado reprova enquanto o status ainda responde 200 com timers', () => {
  const verdict = evaluateContainment({
    live: OK_LIVE,
    health: OK_HEALTH,
    status: enabledStatus(),
    preferences: PREFERENCES_403,
    expect: 'disabled',
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.includes('403')));
  assert.ok(verdict.problems.some((problem) => problem.includes('scheduler.timer_active')));
  assert.ok(verdict.problems.some((problem) => problem.includes('worker.timer_active')));
});

test('health ou liveness fora do ar reprovam a verificação', () => {
  const verdict = evaluateContainment({
    live: { status: 503, body: null },
    health: { status: 500, body: null },
    status: disabledStatus(),
    preferences: PREFERENCES_404,
    expect: 'disabled',
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.includes('/api/live')));
  assert.ok(verdict.problems.some((problem) => problem.includes('/api/health')));
});

test('preferences 403 no estado desabilitado reprova (rota deveria estar ausente)', () => {
  const verdict = evaluateContainment({
    live: OK_LIVE,
    health: OK_HEALTH,
    status: disabledStatus(),
    preferences: PREFERENCES_403,
    expect: 'disabled',
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.includes('/api/dot/preferences')));
});
