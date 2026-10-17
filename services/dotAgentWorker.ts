import { getDb } from '../lib/db.js';
import { runCurrentDotMissionStep } from './dotAgentMissionRunner.js';

let timer: NodeJS.Timeout | null = null;
let running = false;
let tickInFlight: Promise<void> | null = null;

async function runTick() {
  if (running) return;
  running = true;
  try {
    const db = getDb();
    const missions = await db.all(
      "SELECT id, empresa_id FROM dot_agent_missions WHERE status IN ('planned','working') ORDER BY updated_at ASC LIMIT 25",
    );

    for (const mission of missions || []) {
      try {
        // Uma rodada pode atravessar várias etapas determinísticas da mesma missão.
        // Paramos imediatamente quando a missão pede aprovação ou não avança mais.
        for (let step = 0; step < 6; step += 1) {
          const result = await runCurrentDotMissionStep(String(mission.empresa_id), Number(mission.id));
          if (!result) break;
          if (result.blocked) {
            // A mensagem reflete o estado real (aprovação pendente, pausa ou
            // falha temporária) em vez de assumir sempre "aguardando aprovação".
            console.log(`🤖 DOT agente: missão ${mission.id} bloqueada — ${result.reason}`);
            break;
          }
          const state = result.mission;
          if (!state || ['completed', 'waiting_approval', 'paused'].includes(String(state.status))) break;
          if (Number(state.current_step ?? -1) >= Number(state.total_steps ?? 6)) break;
        }
      } catch (error: any) {
        console.warn(`DOT agente: falha na missão ${mission.id}:`, error?.message || error);
      }
    }
  } finally {
    running = false;
  }
}

export function startDotAgentWorker() {
  if (process.env.DOT_AGENT_WORKER_ENABLED === '0') return;
  if (timer) return;

  const intervalMs = Math.max(60_000, Number(process.env.DOT_AGENT_WORKER_INTERVAL_MS || 300_000));

  void runTick();
  timer = setInterval(() => void runTick(), intervalMs);
  timer.unref();
  console.log(`🤖 DOT agente em background: intervalo ${Math.round(intervalMs / 60000)} min.`);
}

export function wakeDotAgentWorker() {
  if (process.env.DOT_AGENT_WORKER_ENABLED === '0') return;
  if (tickInFlight) return tickInFlight;
  tickInFlight = runTick().finally(() => {
    tickInFlight = null;
  });
  return tickInFlight;
}

/** Estado do worker para observabilidade em `/api/dot/status`. */
export function getDotAgentWorkerStatus() {
  return {
    disabled: process.env.DOT_AGENT_WORKER_ENABLED === '0',
    timer_active: Boolean(timer),
    running,
    interval_ms: Math.max(60_000, Number(process.env.DOT_AGENT_WORKER_INTERVAL_MS || 300_000)),
  };
}

export function stopDotAgentWorker() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
