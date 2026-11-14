/**
 * Regras operacionais dos alertas A1–A12 do Filtra Dot.
 *
 * Fonte de dados: `GET /api/metrics` (contadores + estado do scheduler/worker)
 * e `GET /api/health` (ok/db_ok). Não há dependência de plataforma: o coletor
 * roda em qualquer host que alcance a API e leia o token de métricas.
 *
 * Regras de janela: o delta é calculado contra o snapshot mais recente que já
 * tenha a janela completa. Sem esse snapshot (boot ou após deploy), as regras
 * de delta ficam em aquecimento e não disparam. Se qualquer contador diminuir
 * entre os snapshots, houve reinício: as regras de delta também não disparam
 * para não gerar falso positivo com números truncados.
 */

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';

export type Snapshot = {
  ts: number;
  metrics: Record<string, unknown> | null;
  health: Record<string, unknown> | null;
};

export type AlertConfig = {
  version: number;
  source?: string;
  endpoints?: { metrics?: string; health?: string };
  alerts: Record<string, Record<string, number | string>>;
};

export type AlertState = {
  healthFailures: number;
  inFlightSince: number | null;
};

export type AlertHit = {
  id: string;
  severity: AlertSeverity;
  title: string;
  value: number | string;
  threshold: number | string;
  message: string;
  action: string;
};

type RuleContext = {
  history: Snapshot[];
  cur: Snapshot;
  state: AlertState;
  config: AlertConfig;
};

type Rule = {
  id: string;
  evaluate: (ctx: RuleContext) => AlertHit | null;
};

const SEVERITY_ORDER: Record<AlertSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function at(source: unknown, path: string): unknown {
  let acc: unknown = source;
  for (const key of path.split('.')) {
    if (!acc || typeof acc !== 'object' || !(key in (acc as Record<string, unknown>))) return undefined;
    acc = (acc as Record<string, unknown>)[key];
  }
  return acc;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function counterValue(snapshot: Snapshot | null, name: string): number {
  return numberOrNull(at(snapshot?.metrics, `counters.${name}`)) ?? 0;
}

function counterNames(...snapshots: Snapshot[]): string[] {
  const names = new Set<string>();
  for (const snapshot of snapshots) {
    const counters = at(snapshot.metrics, 'counters');
    if (counters && typeof counters === 'object') {
      for (const key of Object.keys(counters as Record<string, unknown>)) names.add(key);
    }
  }
  return [...names];
}

function restartedBetween(prev: Snapshot, cur: Snapshot): boolean {
  return counterNames(prev, cur).some((name) => counterValue(cur, name) < counterValue(prev, name));
}

/** Snapshot mais recente que já completou a janela pedida (ou null). */
export function pickPrevious(history: Snapshot[], targetTs: number): Snapshot | null {
  let best: Snapshot | null = null;
  for (const snapshot of history) {
    if (snapshot.ts <= targetTs && (!best || snapshot.ts > best.ts)) best = snapshot;
  }
  return best;
}

/** Soma dos deltas de contadores na janela; null = aquecimento/reinício. */
function deltaSum(ctx: RuleContext, windowSeconds: number, names: string[]): number | null {
  const prev = pickPrevious(ctx.history, ctx.cur.ts - windowSeconds * 1000);
  if (!prev) return null;
  if (restartedBetween(prev, ctx.cur)) return null;
  return names.reduce((total, name) => total + Math.max(0, counterValue(ctx.cur, name) - counterValue(prev, name)), 0);
}

function routeErrorsDelta(ctx: RuleContext, windowSeconds: number): Array<{ route: string; delta: number }> | null {
  const prev = pickPrevious(ctx.history, ctx.cur.ts - windowSeconds * 1000);
  if (!prev) return null;
  if (restartedBetween(prev, ctx.cur)) return null;
  const routes = at(ctx.cur.metrics, 'http.routes');
  if (!routes || typeof routes !== 'object') return [];
  const out: Array<{ route: string; delta: number }> = [];
  for (const route of Object.keys(routes as Record<string, unknown>)) {
    const before = numberOrNull(at(prev.metrics, `http.routes.${route}.errors`)) ?? 0;
    const now = numberOrNull(at(ctx.cur.metrics, `http.routes.${route}.errors`)) ?? 0;
    if (now - before > 0) out.push({ route, delta: now - before });
  }
  return out;
}

function cfg(ctx: RuleContext, id: string): Record<string, number | string> {
  const entry = ctx.config.alerts[id];
  if (!entry) throw new Error(`Alerta ${id} ausente na configuração`);
  return entry;
}

function hit(
  id: string,
  entry: Record<string, number | string>,
  value: number | string,
  threshold: number | string,
  message: string,
  action: string,
): AlertHit {
  return {
    id,
    severity: String(entry.severity) as AlertSeverity,
    title: String(entry.title),
    value,
    threshold,
    message,
    action,
  };
}

function healthFailed(snapshot: Snapshot): boolean {
  if (!snapshot.health) return true;
  return snapshot.health.ok === false || snapshot.health.db_ok === false;
}

const RULES: Rule[] = [
  {
    id: 'A1',
    evaluate: (ctx) => {
      const entry = cfg(ctx, 'A1');
      const window = Number(entry.window_seconds);
      const requests = deltaSum(ctx, window, ['http_requests_total']);
      const errors = deltaSum(ctx, window, ['http_5xx_total']);
      if (requests !== null && errors !== null && requests >= Number(entry.min_requests) && requests > 0) {
        const ratio = errors / requests;
        if (ratio > Number(entry.ratio_threshold)) {
          return hit('A1', entry, Number(ratio.toFixed(4)), Number(entry.ratio_threshold),
            `${errors} respostas 5xx em ${requests} requisições (${(ratio * 100).toFixed(2)}%)`,
            'Buscar http_request_failed pelo request_id; verificar banco e provedor.');
        }
      }
      const perRoute = routeErrorsDelta(ctx, Number(entry.route_error_window_seconds));
      if (perRoute) {
        const worst = perRoute.reduce<{ route: string; delta: number } | null>(
          (acc, item) => (!acc || item.delta > acc.delta ? item : acc), null,
        );
        if (worst && worst.delta > Number(entry.route_error_threshold)) {
          return hit('A1', entry, worst.delta, Number(entry.route_error_threshold),
            `${worst.delta} erros em ${worst.route}`,
            'Inspecionar a rota e o request_id correspondente; verificar banco e provedor.');
        }
      }
      return null;
    },
  },
  {
    id: 'A2',
    evaluate: (ctx) => {
      const entry = cfg(ctx, 'A2');
      const delta = deltaSum(ctx, Number(entry.window_seconds), [
        'dot_chat_ambiguous',
        'dot_http_idempotency_ambiguous',
        'dot_ledger_sweep_ambiguous',
      ]);
      if (delta !== null && delta > Number(entry.threshold)) {
        return hit('A2', entry, delta, Number(entry.threshold),
          `${delta} transições ambíguas na janela`,
          'Reconciliar reservas/registros ambíguos; nunca reenviar automaticamente.');
      }
      return null;
    },
  },
  {
    id: 'A3',
    evaluate: (ctx) => {
      const entry = cfg(ctx, 'A3');
      const delta = deltaSum(ctx, Number(entry.window_seconds), ['dot_ledger_finalize_error']);
      const pendingMetric = at(ctx.cur.metrics, 'dot.pending_sent_over_grace');
      const pending = numberOrNull(pendingMetric);
      // Campo ausente = API antiga (compatibilidade); null/inválido explícito =
      // a consulta da gauge falhou, portanto não pode ser tratado como zero.
      const gaugeUnavailable = pendingMetric !== undefined && pending === null;
      const firedByCounter = delta !== null && delta > Number(entry.threshold);
      if (firedByCounter || gaugeUnavailable || (pending !== null && pending > 0)) {
        const value = firedByCounter
          ? (delta as number)
          : gaugeUnavailable ? 'gauge_unavailable' : (pending as number);
        return hit('A3', entry, value, Number(entry.threshold),
          gaugeUnavailable
            ? 'Gauge de reservas enviadas indisponível; não foi possível verificar a divergência'
            : 'Liquidação falhou ou há reserva enviada além da carência',
          'Verificar /api/metrics e dot_budget_reservations; reconciliar manualmente se necessário.');
      }
      return null;
    },
  },
  {
    id: 'A4',
    evaluate: (ctx) => {
      const entry = cfg(ctx, 'A4');
      const exceeded = deltaSum(ctx, Number(entry.window_seconds), ['dot_budget_exceeded']);
      const critical = deltaSum(ctx, Number(entry.window_seconds), ['dot_budget_alert_critical']);
      const firedByCounter = exceeded !== null && exceeded > Number(entry.threshold);
      const firedByCritical = critical !== null && critical > 0;
      if (firedByCounter || firedByCritical) {
        return hit('A4', entry, firedByCounter ? (exceeded as number) : (critical as number), Number(entry.threshold),
          'Orçamento esgotado ou alerta crítico de orçamento emitido',
          'Validar plano/limite, comunicar o cliente e verificar abuso.');
      }
      return null;
    },
  },
  {
    id: 'A5',
    evaluate: (ctx) => {
      const entry = cfg(ctx, 'A5');
      if (at(ctx.cur.metrics, 'dot.enabled') !== true) return null;
      const scheduler = at(ctx.cur.metrics, 'dot.scheduler');
      const lastError = at(scheduler, 'last_error');
      const timerActive = at(scheduler, 'timer_active');
      const tickMs = numberOrNull(at(scheduler, 'tick_ms')) ?? 300_000;
      const multiplier = Number(entry.stale_tick_multiplier);
      const lastRunAt = at(scheduler, 'last_run_at');
      let stale = false;
      if (typeof lastRunAt === 'string') {
        const parsed = Date.parse(lastRunAt);
        if (Number.isFinite(parsed)) stale = ctx.cur.ts - parsed > tickMs * multiplier;
      } else {
        const uptimeSeconds = numberOrNull(at(ctx.cur.metrics, 'http.uptime_s')) ?? 0;
        stale = uptimeSeconds * 1000 > tickMs * multiplier;
      }
      if (lastError != null || timerActive === false || stale) {
        return hit('A5', entry, lastError != null ? String(lastError) : timerActive === false ? 'timer_inactive' : 'stale', tickMs,
          'Scheduler inativo, com erro ou sem rodada no intervalo esperado',
          'Reiniciar a instância e verificar o lock dot:scheduler.');
      }
      return null;
    },
  },
  {
    id: 'A6',
    evaluate: (ctx) => {
      const entry = cfg(ctx, 'A6');
      const worker = at(ctx.cur.metrics, 'dot.agent_worker');
      const stopped = at(worker, 'stopped') === true;
      const inFlightSeconds = ctx.state.inFlightSince === null ? 0 : (ctx.cur.ts - ctx.state.inFlightSince) / 1000;
      if (stopped || inFlightSeconds > Number(entry.in_flight_seconds)) {
        return hit('A6', entry, stopped ? 'stopped' : Math.round(inFlightSeconds), Number(entry.in_flight_seconds),
          stopped ? 'Worker de agente parado' : `Tick do worker em execução há ${Math.round(inFlightSeconds)}s`,
          'Verificar missões presas em working e reiniciar o worker.');
      }
      return null;
    },
  },
  {
    id: 'A7',
    evaluate: (ctx) => {
      const entry = cfg(ctx, 'A7');
      if (ctx.state.healthFailures >= Number(entry.consecutive_failures)) {
        return hit('A7', entry, ctx.state.healthFailures, Number(entry.consecutive_failures),
          `${ctx.state.healthFailures} verificações de health consecutivas falharam`,
          'Verificar db_ok, pool de conexões e logs de boot.');
      }
      return null;
    },
  },
  {
    id: 'A8',
    evaluate: (ctx) => {
      const entry = cfg(ctx, 'A8');
      const window = Number(entry.window_seconds);
      const failed = deltaSum(ctx, window, ['ai_provider_call_failed']);
      const completed = deltaSum(ctx, window, ['ai_provider_call_completed']);
      const unconfigured = deltaSum(ctx, window, ['ai_not_configured']);
      if (unconfigured !== null && unconfigured > 0) {
        return hit('A8', entry, unconfigured, 0,
          'Nenhum provedor de IA configurado',
          'Configurar GROQ_API_KEY/GEMINI_API_KEY e validar AI_PROVIDER_ORDER.');
      }
      if (failed !== null && completed !== null && failed >= Number(entry.failed_threshold) && completed === 0) {
        return hit('A8', entry, failed, Number(entry.failed_threshold),
          `${failed} falhas de provedor sem sucesso na janela`,
          'Validar chaves/quotas Groq/Gemini e o failover.');
      }
      return null;
    },
  },
  {
    id: 'A9',
    evaluate: (ctx) => {
      const entry = cfg(ctx, 'A9');
      const dbDown = ctx.cur.health ? ctx.cur.health.db_ok === false || ctx.cur.health.ok === false : false;
      // `dot_ledger_finalize_error` é sinal financeiro (A3); aqui ficam os
      // erros de infraestrutura do ledger para não duplicar o mesmo alerta.
      const delta = deltaSum(ctx, Number(entry.window_seconds), [
        'dot_ledger_reserve_error',
        'dot_ledger_sweep_error',
      ]);
      if (dbDown || (delta !== null && delta > Number(entry.threshold))) {
        return hit('A9', entry, dbDown ? 'db_down' : delta ?? 0, Number(entry.threshold),
          'Falha de banco detectada pelo health ou por operações do ledger',
          'Verificar Supabase, conexões, disco e locks.');
      }
      return null;
    },
  },
  {
    id: 'A10',
    evaluate: (ctx) => {
      const entry = cfg(ctx, 'A10');
      const delta = deltaSum(ctx, Number(entry.window_seconds), [
        'dot_http_idempotency_complete_lost',
        'dot_idempotency_unavailable',
      ]);
      if (delta !== null && delta > Number(entry.threshold)) {
        return hit('A10', entry, delta, Number(entry.threshold),
          'Falha ao concluir ou reservar idempotência HTTP',
          'Verificar tabela dot_http_idempotency, índices e réplicas.');
      }
      return null;
    },
  },
  {
    id: 'A11',
    evaluate: (ctx) => {
      const entry = cfg(ctx, 'A11');
      const delta = deltaSum(ctx, Number(entry.window_seconds), ['dot_idempotency_key_reused']);
      if (delta !== null && delta > Number(entry.threshold)) {
        return hit('A11', entry, delta, Number(entry.threshold),
          'Chave de idempotência reutilizada com outro conteúdo',
          'Investigar cliente/versão; a API já responde 409.');
      }
      return null;
    },
  },
  {
    id: 'A12',
    evaluate: (ctx) => {
      const entry = cfg(ctx, 'A12');
      const route = String(entry.route);
      const p95 = numberOrNull(at(ctx.cur.metrics, `http.routes.${route}.p95_ms`));
      const samples = numberOrNull(at(ctx.cur.metrics, `http.routes.${route}.window`)) ?? 0;
      if (p95 !== null && samples >= Number(entry.min_samples) && p95 > Number(entry.p95_threshold_ms)) {
        return hit('A12', entry, p95, Number(entry.p95_threshold_ms),
          `p95 de ${route} em ${p95} ms (${samples} amostras)`,
          'Verificar provedor e o timeout de 45 s do cliente.');
      }
      return null;
    },
  },
];

export const ALERT_IDS = RULES.map((rule) => rule.id);

export function loadAlertConfig(raw: unknown): AlertConfig {
  if (!raw || typeof raw !== 'object') throw new Error('Configuração de alertas inválida');
  const config = raw as AlertConfig;
  if (!config.alerts || typeof config.alerts !== 'object') throw new Error('Configuração sem bloco alerts');
  const missing = ALERT_IDS.filter((id) => !config.alerts[id]);
  if (missing.length) throw new Error(`Configuração sem alertas obrigatórios: ${missing.join(', ')}`);
  const extra = Object.keys(config.alerts).filter((id) => !ALERT_IDS.includes(id));
  if (extra.length) throw new Error(`Configuração com alertas desconhecidos: ${extra.join(', ')}`);
  return config;
}

/** Atualiza o estado do coletor e avalia todas as regras. */
export function evaluateAlerts(input: {
  history: Snapshot[];
  current: Snapshot;
  config: AlertConfig;
  state?: AlertState;
}): { hits: AlertHit[]; state: AlertState } {
  const state: AlertState = {
    healthFailures: input.state?.healthFailures ?? 0,
    inFlightSince: input.state?.inFlightSince ?? null,
  };

  state.healthFailures = healthFailed(input.current) ? state.healthFailures + 1 : 0;
  const inFlight = at(input.current.metrics, 'dot.agent_worker.in_flight') === true;
  state.inFlightSince = inFlight ? state.inFlightSince ?? input.current.ts : null;

  const ctx: RuleContext = { history: input.history, cur: input.current, state, config: input.config };
  const hits: AlertHit[] = [];
  for (const rule of RULES) {
    const result = rule.evaluate(ctx);
    if (result) hits.push(result);
  }
  hits.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id));
  return { hits, state };
}

/** Mantém apenas os snapshots necessários para a maior janela configurada. */
export function pruneHistory(history: Snapshot[], config: AlertConfig, now: number): Snapshot[] {
  const windows = Object.values(config.alerts)
    .map((entry) => Number(entry.window_seconds ?? 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  const maxWindow = windows.length ? Math.max(...windows) : 3600;
  return history.filter((snapshot) => now - snapshot.ts <= maxWindow * 1000).sort((a, b) => a.ts - b.ts);
}
