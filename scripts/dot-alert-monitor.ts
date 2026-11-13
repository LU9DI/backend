/**
 * Coletor/executor dos alertas A1–A12 do Filtra Dot.
 *
 * Uso (dry-run por padrão, nada é enviado):
 *   npx tsx scripts/dot-alert-monitor.ts --once
 *   npx tsx scripts/dot-alert-monitor.ts --interval 60 --send
 *
 * Variáveis de ambiente:
 *   DOT_ALERT_BASE_URL      base da API (padrão http://127.0.0.1:5000)
 *   METRICS_TOKEN           token de leitura de /api/metrics (ou JOBS_SECRET)
 *   DOT_ALERT_WEBHOOK_URL   destino do alerta; só usado com --send
 *
 * Segredos nunca são impressos: nem o token, nem a URL do webhook.
 */
import { renameSync, writeFileSync } from 'node:fs';
import {
  buildWebhookPayload,
  collectAndEvaluate,
  loadAlertConfigFile,
  loadMonitorState,
  sendWebhook,
} from '../lib/dotAlertMonitor.js';
import { pruneHistory, type AlertState, type Snapshot } from '../lib/dotAlertRules.js';

type Args = {
  once: boolean;
  send: boolean;
  failOnAlert: boolean;
  intervalSeconds: number;
  statePath: string | null;
  configPath: string;
  baseUrl: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    once: false,
    send: false,
    failOnAlert: false,
    intervalSeconds: 60,
    statePath: null,
    configPath: 'ops/alerts/dot-alerts.json',
    baseUrl: process.env.DOT_ALERT_BASE_URL || 'http://127.0.0.1:5000',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--once') args.once = true;
    else if (arg === '--send') args.send = true;
    else if (arg === '--fail-on-alert') args.failOnAlert = true;
    else if (arg === '--interval') args.intervalSeconds = Math.max(10, Number(argv[++index]) || 60);
    else if (arg === '--state') args.statePath = argv[++index] || null;
    else if (arg === '--config') args.configPath = argv[++index] || args.configPath;
    else if (arg === '--base-url') args.baseUrl = argv[++index] || args.baseUrl;
    else if (arg === '--help' || arg === '-h') {
      console.log('Uso: npx tsx scripts/dot-alert-monitor.ts [--once] [--interval 60] [--send] [--fail-on-alert] [--state file.json] [--config ops/alerts/dot-alerts.json] [--base-url URL]');
      process.exit(0);
    } else {
      throw new Error(`Argumento desconhecido: ${arg}`);
    }
  }
  return args;
}

function persistState(path: string, history: Snapshot[], state: AlertState): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ history, state }), 'utf8');
  renameSync(tmp, path);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadAlertConfigFile(args.configPath);
  const token = (process.env.METRICS_TOKEN || process.env.JOBS_SECRET || '').trim() || undefined;
  const webhookUrl = (process.env.DOT_ALERT_WEBHOOK_URL || '').trim();
  if (args.send && !webhookUrl) {
    throw new Error('--send exige DOT_ALERT_WEBHOOK_URL no ambiente');
  }

  const persisted = args.statePath ? loadMonitorState(args.statePath) : { history: [], state: { healthFailures: 0, inFlightSince: null } };
  let history = persisted.history;
  let state = persisted.state;

  const runOnce = async (): Promise<number> => {
    const result = await collectAndEvaluate({
      options: { baseUrl: args.baseUrl, metricsToken: token },
      config,
      history,
      state,
    });
    history = pruneHistory(result.history, config, Date.now());
    state = result.state;
    if (args.statePath) persistState(args.statePath, history, state);

    for (const alert of result.hits) console.log(JSON.stringify(alert));
    if (result.hits.length && args.send) {
      const status = await sendWebhook(webhookUrl, buildWebhookPayload(result.hits));
      console.error(`[dot-alert-monitor] webhook respondeu HTTP ${status}`);
    }
    return result.hits.length;
  };

  if (args.once) {
    const count = await runOnce();
    if (args.failOnAlert && count > 0) process.exit(2);
    return;
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    try {
      const count = await runOnce();
      if (count > 0 && !args.send) {
        console.error(`[dot-alert-monitor] ${count} alerta(s) em modo dry-run (nada enviado)`);
      }
    } catch (error) {
      console.error(`[dot-alert-monitor] falha na coleta: ${String((error as Error)?.message || error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, args.intervalSeconds * 1000));
  }
}

main().catch((error) => {
  console.error(`[dot-alert-monitor] erro fatal: ${String((error as Error)?.message || error)}`);
  process.exit(1);
});
