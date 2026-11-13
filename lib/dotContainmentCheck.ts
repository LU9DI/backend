/**
 * Avaliação do estado de contenção do Filtra Dot a partir de respostas HTTP
 * públicas (somente leitura). Usado pelo script de validação do runbook de
 * contenção e por testes — nunca faz requisições nem altera nada.
 *
 * Estado "enabled": o build monta as rotas e os timers (flags ligadas).
 * Estado "disabled": `/api/dot/status` é o tombstone 403 e as demais rotas do
 * Dot não existem (404).
 */

export type ProbeResult = {
  status: number;
  body: Record<string, unknown> | null;
};

export type ContainmentExpectation = 'enabled' | 'disabled';

export type ContainmentInput = {
  live: ProbeResult;
  health: ProbeResult;
  status: ProbeResult;
  preferences: ProbeResult;
  expect: ContainmentExpectation;
};

export type ContainmentSummary = {
  expect: ContainmentExpectation;
  live_status: number;
  health_status: number;
  dot_status_status: number;
  dot_status_enabled: boolean | null;
  scheduler_timer_active: boolean | null;
  worker_timer_active: boolean | null;
  preferences_status: number;
};

export type ContainmentVerdict = {
  ok: boolean;
  summary: ContainmentSummary;
  problems: string[];
};

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function evaluateContainment(input: ContainmentInput): ContainmentVerdict {
  const statusBody = input.status.body ?? {};
  const scheduler = obj(statusBody.scheduler);
  const worker = obj(statusBody.worker);
  const summary: ContainmentSummary = {
    expect: input.expect,
    live_status: input.live.status,
    health_status: input.health.status,
    dot_status_status: input.status.status,
    dot_status_enabled: boolOrNull(statusBody.enabled),
    scheduler_timer_active: boolOrNull(scheduler?.timer_active),
    worker_timer_active: boolOrNull(worker?.timer_active),
    preferences_status: input.preferences.status,
  };

  const problems: string[] = [];
  if (input.live.status !== 200) problems.push(`/api/live respondeu HTTP ${input.live.status}`);
  if (input.health.status !== 200) problems.push(`/api/health respondeu HTTP ${input.health.status}`);

  if (input.expect === 'enabled') {
    if (input.status.status !== 200) {
      problems.push(`esperado /api/dot/status 200 (Dot montado), recebido ${input.status.status}`);
    }
    if (scheduler?.timer_active !== true) problems.push('scheduler.timer_active não é true');
    if (worker?.timer_active !== true) problems.push('worker.timer_active não é true');
    if (input.preferences.status !== 403) {
      problems.push(`esperado /api/dot/preferences 403 (auth), recebido ${input.preferences.status}`);
    }
  } else {
    if (input.status.status !== 403) {
      problems.push(`esperado /api/dot/status 403 (tombstone), recebido ${input.status.status}`);
    }
    if (statusBody.enabled !== false) problems.push('status.enabled não é false');
    if (scheduler?.timer_active === true) problems.push('scheduler.timer_active ainda é true');
    if (worker?.timer_active === true) problems.push('worker.timer_active ainda é true');
    if (input.preferences.status !== 404) {
      problems.push(`esperado /api/dot/preferences 404 (rota ausente), recebido ${input.preferences.status}`);
    }
  }

  return { ok: problems.length === 0, summary, problems };
}
