/**
 * Coletor dos alertas do Filtra Dot.
 *
 * Lê `/api/metrics` (token de métricas, quando exigido) e `/api/health`, avalia
 * as regras A1–A12 e devolve os disparos. Não envia nada por conta própria: o
 * envio ao webhook é explícito (`sendWebhook`) e o token nunca entra no payload
 * nem em mensagens de erro.
 */
import { readFileSync } from 'node:fs';
import {
  evaluateAlerts,
  loadAlertConfig,
  pruneHistory,
  type AlertConfig,
  type AlertHit,
  type AlertState,
  type Snapshot,
} from './dotAlertRules.js';

export type MonitorOptions = {
  baseUrl: string;
  metricsToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type CollectResult = {
  snapshot: Snapshot;
  hits: AlertHit[];
  state: AlertState;
  history: Snapshot[];
};

export type WebhookPayload = {
  source: 'filtra-dot-alerts';
  fired_at: string;
  alerts: Array<Pick<AlertHit, 'id' | 'severity' | 'title' | 'value' | 'threshold' | 'message' | 'action'>>;
};

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = String(baseUrl || '').trim();
  if (!trimmed) throw new Error('DOT_ALERT_BASE_URL ausente');
  return trimmed.replace(/\/+$/, '');
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  allowErrorStatus = false,
): Promise<unknown> {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok && !(allowErrorStatus && body !== null)) {
    // Nunca inclui headers/token na mensagem.
    throw new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
  }
  return body;
}

export function loadAlertConfigFile(path: string): AlertConfig {
  return loadAlertConfig(JSON.parse(readFileSync(path, 'utf8')));
}

/** Busca as duas fontes e monta o snapshot do instante. */
export async function collectSnapshot(options: MonitorOptions, now = Date.now()): Promise<Snapshot> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.metricsToken) headers['x-metrics-token'] = options.metricsToken;

  const [metrics, health] = await Promise.all([
    getJson(`${baseUrl}/api/metrics`, headers, timeoutMs, fetchImpl),
    // `/api/health` responde 503 quando o banco cai e ainda traz o corpo
    // (`ok`/`db_ok`); por isso o status de erro é aceito aqui.
    getJson(`${baseUrl}/api/health`, { accept: 'application/json' }, timeoutMs, fetchImpl, true).catch(() => null),
  ]);

  return {
    ts: now,
    metrics: (metrics && typeof metrics === 'object' ? (metrics as Record<string, unknown>) : null),
    health: (health && typeof health === 'object' ? (health as Record<string, unknown>) : null),
  };
}

/** Coleta, avalia e devolve o histórico já podado para a maior janela. */
export async function collectAndEvaluate(input: {
  options: MonitorOptions;
  config: AlertConfig;
  history?: Snapshot[];
  state?: AlertState;
  now?: number;
}): Promise<CollectResult> {
  const now = input.now ?? Date.now();
  const snapshot = await collectSnapshot(input.options, now);
  const history = pruneHistory(input.history ?? [], input.config, now);
  const { hits, state } = evaluateAlerts({
    history,
    current: snapshot,
    config: input.config,
    state: input.state,
  });
  return { snapshot, hits, state, history: [...history, snapshot].slice(-500) };
}

export function buildWebhookPayload(hits: AlertHit[], now = new Date()): WebhookPayload {
  return {
    source: 'filtra-dot-alerts',
    fired_at: now.toISOString(),
    alerts: hits.map(({ id, severity, title, value, threshold, message, action }) => ({
      id,
      severity,
      title,
      value,
      threshold,
      message,
      action,
    })),
  };
}

/** Envia o payload; devolve o status HTTP. A URL não é registrada em log. */
export async function sendWebhook(
  webhookUrl: string,
  payload: WebhookPayload,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<number> {
  const response = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response.status;
}

export function loadMonitorState(path: string): { history: Snapshot[]; state: AlertState } {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { history?: Snapshot[]; state?: AlertState };
    return {
      history: Array.isArray(raw.history) ? raw.history : [],
      state: {
        healthFailures: Number(raw.state?.healthFailures) || 0,
        inFlightSince: typeof raw.state?.inFlightSince === 'number' ? raw.state.inFlightSince : null,
      },
    };
  } catch {
    return { history: [], state: { healthFailures: 0, inFlightSince: null } };
  }
}
