import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ALERT_IDS,
  evaluateAlerts,
  loadAlertConfig,
  type AlertConfig,
  type AlertState,
  type Snapshot,
} from '../lib/dotAlertRules.js';
import {
  buildWebhookPayload,
  collectAndEvaluate,
  loadMonitorState,
  sendWebhook,
} from '../lib/dotAlertMonitor.js';

const here = dirname(fileURLToPath(import.meta.url));
const config: AlertConfig = loadAlertConfig(
  JSON.parse(readFileSync(join(here, '..', 'ops', 'alerts', 'dot-alerts.json'), 'utf8')),
);

type Fixture = {
  counters?: Record<string, number>;
  health?: Record<string, unknown> | null;
  dot?: Record<string, unknown>;
  routes?: Record<string, unknown>;
  uptime?: number;
};

function snapshot(ts: number, fixture: Fixture = {}): Snapshot {
  return {
    ts,
    metrics: {
      counters: fixture.counters ?? {},
      http: { uptime_s: fixture.uptime ?? 600, routes: fixture.routes ?? {} },
      dot: fixture.dot ?? {},
    },
    health: fixture.health === undefined ? { ok: true, db_ok: true } : fixture.health,
  };
}

const T0 = Date.parse('2026-11-11T12:00:00.000Z');
const HOUR = 3_600_000;

function run(prev: Snapshot | null, cur: Snapshot, state?: AlertState) {
  return evaluateAlerts({ history: prev ? [prev] : [], current: cur, config, state }).hits;
}

function ids(hits: Array<{ id: string }>): string[] {
  return hits.map((hit) => hit.id);
}

test('configuração cobre exatamente A1–A12', () => {
  assert.deepEqual(Object.keys(config.alerts).sort(), [...ALERT_IDS].sort());
});

test('snapshot saudável não dispara nenhum alerta', () => {
  const counters = { http_requests_total: 1000, http_5xx_total: 10, dot_chat_completed: 5 };
  const prev = snapshot(T0 - HOUR, { counters });
  const cur = snapshot(T0, { counters, dot: { enabled: true, scheduler: { timer_active: true, tick_ms: 60_000, last_run_at: new Date(T0).toISOString() }, agent_worker: { stopped: false, in_flight: false } } });
  assert.deepEqual(run(prev, cur), []);
});

test('A1 dispara por proporção de 5xx acima de 5%', () => {
  const prev = snapshot(T0 - HOUR, { counters: { http_requests_total: 1000, http_5xx_total: 10 } });
  const cur = snapshot(T0, { counters: { http_requests_total: 1150, http_5xx_total: 30 } });
  assert.deepEqual(ids(run(prev, cur)), ['A1']);
});

test('A1 dispara por erros de uma rota acima de 10', () => {
  const prev = snapshot(T0 - HOUR, { counters: { http_requests_total: 1000 }, routes: { 'GET /api/x': { errors: 1, window: 10 } } });
  const cur = snapshot(T0, { counters: { http_requests_total: 1001 }, routes: { 'GET /api/x': { errors: 13, window: 10 } } });
  assert.deepEqual(ids(run(prev, cur)), ['A1']);
});

test('A1 não dispara abaixo do mínimo de requisições', () => {
  const prev = snapshot(T0 - HOUR, { counters: { http_requests_total: 10, http_5xx_total: 1 } });
  const cur = snapshot(T0, { counters: { http_requests_total: 20, http_5xx_total: 5 } });
  assert.deepEqual(ids(run(prev, cur)), []);
});

test('A2 dispara com transição ambígua', () => {
  const prev = snapshot(T0 - HOUR, { counters: { dot_chat_ambiguous: 1 } });
  const cur = snapshot(T0, { counters: { dot_chat_ambiguous: 2 } });
  assert.deepEqual(ids(run(prev, cur)), ['A2']);
});

test('A3 dispara quando a liquidação falha', () => {
  const prev = snapshot(T0 - HOUR, { counters: { dot_ledger_finalize_error: 0 } });
  const cur = snapshot(T0, { counters: { dot_ledger_finalize_error: 1 } });
  const fired = ids(run(prev, cur));
  assert.ok(fired.includes('A3'));
  assert.ok(!fired.includes('A9'), 'erro de liquidação é sinal financeiro (A3), não de banco (A9)');
});

test('A3 dispara com reserva enviada além da carência (campo opcional)', () => {
  const cur = snapshot(T0, { dot: { pending_sent_over_grace: 2 } });
  assert.ok(ids(run(null, cur)).includes('A3'));
});

test('A4 dispara acima de 10 orçamentos excedidos na janela', () => {
  const prev = snapshot(T0 - HOUR, { counters: { dot_budget_exceeded: 1 } });
  const cur = snapshot(T0, { counters: { dot_budget_exceeded: 12 } });
  assert.deepEqual(ids(run(prev, cur)), ['A4']);
});

test('A4 dispara com alerta crítico de orçamento', () => {
  const prev = snapshot(T0 - HOUR, { counters: { dot_budget_alert_critical: 0 } });
  const cur = snapshot(T0, { counters: { dot_budget_alert_critical: 1 } });
  assert.deepEqual(ids(run(prev, cur)), ['A4']);
});

test('A5 dispara com last_error, timer inativo ou rodada atrasada', () => {
  const base = { enabled: true, agent_worker: { stopped: false } };
  const withError = snapshot(T0, { dot: { ...base, scheduler: { last_error: 'boom', timer_active: true, tick_ms: 60_000, last_run_at: new Date(T0).toISOString() } } });
  assert.ok(ids(run(null, withError)).includes('A5'));

  const timerOff = snapshot(T0, { dot: { ...base, scheduler: { last_error: null, timer_active: false, tick_ms: 60_000, last_run_at: new Date(T0).toISOString() } } });
  assert.ok(ids(run(null, timerOff)).includes('A5'));

  const stale = snapshot(T0, { dot: { ...base, scheduler: { last_error: null, timer_active: true, tick_ms: 60_000, last_run_at: new Date(T0 - 10 * 60_000).toISOString() } } });
  assert.ok(ids(run(null, stale)).includes('A5'));
});

test('A5 não dispara com Dot desligado', () => {
  const cur = snapshot(T0, { dot: { enabled: false, scheduler: { last_error: 'boom', timer_active: false, tick_ms: 60_000 } } });
  assert.ok(!ids(run(null, cur)).includes('A5'));
});

test('A6 dispara com worker parado', () => {
  const cur = snapshot(T0, { dot: { enabled: true, agent_worker: { stopped: true, in_flight: false } } });
  assert.deepEqual(ids(run(null, cur)), ['A6']);
});

test('A6 dispara com tick em execução há mais de 30 minutos', () => {
  const cur = snapshot(T0, { dot: { enabled: true, agent_worker: { stopped: false, in_flight: true } } });
  assert.deepEqual(ids(run(null, cur, { healthFailures: 0, inFlightSince: T0 - 31 * 60_000 })), ['A6']);
});

test('A7 exige três falhas consecutivas de health', () => {
  const failing = snapshot(T0, { health: { ok: false, db_ok: false } });
  let state: AlertState = { healthFailures: 0, inFlightSince: null };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = evaluateAlerts({ history: [], current: failing, config, state });
    state = result.state;
    assert.equal(state.healthFailures, attempt);
    assert.equal(ids(result.hits).includes('A7'), attempt === 3);
  }
});

test('A8 dispara com falhas de provedor sem sucesso', () => {
  const prev = snapshot(T0 - HOUR, { counters: { ai_provider_call_failed: 1, ai_provider_call_completed: 5 } });
  const cur = snapshot(T0, { counters: { ai_provider_call_failed: 4, ai_provider_call_completed: 5 } });
  assert.deepEqual(ids(run(prev, cur)), ['A8']);
});

test('A8 dispara quando nenhum provedor está configurado', () => {
  const prev = snapshot(T0 - HOUR, { counters: { ai_not_configured: 0 } });
  const cur = snapshot(T0, { counters: { ai_not_configured: 1 } });
  assert.deepEqual(ids(run(prev, cur)), ['A8']);
});

test('A9 dispara com banco indisponível ou erro de ledger', () => {
  const dbDown = snapshot(T0, { health: { ok: false, db_ok: false } });
  assert.ok(ids(run(null, dbDown)).includes('A9'));

  const prev = snapshot(T0 - HOUR, { counters: { dot_ledger_reserve_error: 0 } });
  const cur = snapshot(T0, { counters: { dot_ledger_reserve_error: 2 } });
  assert.ok(ids(run(prev, cur)).includes('A9'));
});

test('A10 dispara com perda de conclusão ou idempotência indisponível', () => {
  const prev = snapshot(T0 - HOUR, { counters: { dot_http_idempotency_complete_lost: 0 } });
  const cur = snapshot(T0, { counters: { dot_http_idempotency_complete_lost: 1 } });
  assert.deepEqual(ids(run(prev, cur)), ['A10']);
});

test('A11 dispara com chave reutilizada', () => {
  const prev = snapshot(T0 - HOUR, { counters: { dot_idempotency_key_reused: 0 } });
  const cur = snapshot(T0, { counters: { dot_idempotency_key_reused: 1 } });
  assert.deepEqual(ids(run(prev, cur)), ['A11']);
});

test('A12 dispara com p95 acima de 20s e amostras suficientes', () => {
  const routes = { 'POST /api/dot/chat': { p95_ms: 25_000, window: 50 } };
  assert.deepEqual(ids(run(null, snapshot(T0, { routes }))), ['A12']);

  const fewSamples = { 'POST /api/dot/chat': { p95_ms: 25_000, window: 5 } };
  assert.deepEqual(ids(run(null, snapshot(T0, { routes: fewSamples }))), []);
});

test('reinício de contadores não gera falso positivo', () => {
  const prev = snapshot(T0 - HOUR, { counters: { dot_chat_ambiguous: 10, http_requests_total: 500 } });
  const cur = snapshot(T0, { counters: { dot_chat_ambiguous: 2, http_requests_total: 20 } });
  assert.deepEqual(ids(run(prev, cur)), []);
});

test('sem snapshot anterior, regras de delta ficam em aquecimento', () => {
  const cur = snapshot(T0, { counters: { dot_chat_ambiguous: 5, dot_idempotency_key_reused: 2 } });
  assert.deepEqual(ids(run(null, cur)), []);
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('endereço inválido');
  return `http://127.0.0.1:${address.port}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
  });
}

test('coletor lê /api/metrics com token e detecta banco indisponível', async () => {
  const token = 'fixture-token-123';
  let receivedHeader = '';
  const server = createServer((req, res) => {
    if (req.url === '/api/metrics') {
      receivedHeader = String(req.headers['x-metrics-token'] || '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ counters: { dot_ledger_reserve_error: 0 }, http: { uptime_s: 900, routes: {} }, dot: { enabled: true } }));
      return;
    }
    if (req.url === '/api/health') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, db_ok: false }));
      return;
    }
    res.writeHead(404).end();
  });
  const baseUrl = await listen(server);
  try {
    const result = await collectAndEvaluate({
      options: { baseUrl, metricsToken: token },
      config,
      now: T0,
    });
    assert.equal(receivedHeader, token);
    assert.ok(ids(result.hits).includes('A9'));
    assert.ok(!JSON.stringify(result.hits).includes(token));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('coletor recusa métricas sem autorização sem vazar o token', async () => {
  const server = createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Não autorizado.' }));
  });
  const baseUrl = await listen(server);
  try {
    await assert.rejects(
      () => collectAndEvaluate({ options: { baseUrl, metricsToken: 'secret-value' }, config, now: T0 }),
      (error: Error) => error.message.includes('HTTP 401') && !error.message.includes('secret-value'),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('webhook recebe apenas o payload de alerta, sem token', async () => {
  let body = '';
  const server = createServer(async (req, res) => {
    body = await readBody(req);
    res.writeHead(204).end();
  });
  const url = await listen(server);
  try {
    const hits = run(
      snapshot(T0 - HOUR, { counters: { dot_idempotency_key_reused: 0 } }),
      snapshot(T0, { counters: { dot_idempotency_key_reused: 1 } }),
    );
    const payload = buildWebhookPayload(hits, new Date(T0));
    const status = await sendWebhook(url, payload);
    assert.equal(status, 204);
    const parsed = JSON.parse(body) as { source: string; alerts: Array<{ id: string }> };
    assert.equal(parsed.source, 'filtra-dot-alerts');
    assert.deepEqual(parsed.alerts.map((alert) => alert.id), ['A11']);
    assert.ok(!body.includes('secret-value'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('estado persistido ausente começa vazio', () => {
  const state = loadMonitorState(join(here, 'arquivo-que-nao-existe.json'));
  assert.deepEqual(state, { history: [], state: { healthFailures: 0, inFlightSince: null } });
});
