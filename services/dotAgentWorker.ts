import { getDb } from '../lib/db.js';
import { runCurrentDotMissionStep } from './dotAgentMissionRunner.js';

let timer: NodeJS.Timeout | null = null;
let running = false;
/**
 * A promessa do tick em andamento, UMA SÓ para todos os caminhos:
 *
 *  - tick de inicialização (`startDotAgentWorker`);
 *  - tick de timer (`setInterval`);
 *  - tick acordado (`wakeDotAgentWorker`);
 *  - o encerramento gracioso (`stopDotAgentWorkerAndDrain`) aguarda esta
 *    mesma promessa em vez de uma cópia desconectada do trabalho real.
 *
 * Sem o compartilhamento, um tick iniciado pelo timer não era observado pelo
 * drain: o shutdown fechava o pool com a rodada ainda em voo.
 */
let tickInFlight: Promise<void> | null = null;
/** Marcado pela parada: nenhum tick NOVO inicia até um novo `start`. */
let stopped = false;

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

// Falhas transitórias no banco não podem virar rejeições não tratadas:
// o processo Node encerrava quando db.all() falhava antes do loop por missão.
export async function runDotAgentWorkerTick(task: () => Promise<void> = runTick) {
  try {
    await task();
  } catch (error: any) {
    console.warn('[dot-agent-worker] tick falhou; nova tentativa no próximo ciclo:', error?.message || error);
  }
}

/**
 * Porta ÚNICA de execução. Devolve a promessa JÁ em voo quando existir, de
 * modo que inicialização, timer e `wakeDotAgentWorker` nunca iniciem dois
 * ticks simultâneos. Nunca rejeita: `runDotAgentWorkerTick` contém o erro.
 */
function scheduleTick(): Promise<void> {
  if (stopped) return Promise.resolve();
  if (tickInFlight) return tickInFlight;
  const promise = runDotAgentWorkerTick().finally(() => {
    // Só limpa se ainda for esta promessa — um `stop`+`start` concorrente não
    // pode zerar a referência de um tick diferente.
    if (tickInFlight === promise) tickInFlight = null;
  });
  tickInFlight = promise;
  return promise;
}

/**
 * Invariante de boot: nenhum tick do worker pode rodar sem o Dot habilitado.
 * O servidor já monta as rotas/worker apenas com `FILTRA_DOT_ENABLED=1`; esta
 * checagem é a segunda barreira para o caso de uma chamada direta (teste,
 * script ou regressão de wiring) — a mesma usada pelo scheduler.
 */
export function dotWorkerRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FILTRA_DOT_ENABLED === '1' && env.DOT_AGENT_WORKER_ENABLED !== '0';
}

export function startDotAgentWorker() {
  if (!dotWorkerRuntimeEnabled()) return;
  if (timer) return;

  // Reinício após parada: libera a porta para os próximos ticks.
  stopped = false;
  const intervalMs = Math.max(60_000, Number(process.env.DOT_AGENT_WORKER_INTERVAL_MS || 300_000));

  void scheduleTick();
  timer = setInterval(() => void scheduleTick(), intervalMs);
  timer.unref();
  console.log(`🤖 DOT agente em background: intervalo ${Math.round(intervalMs / 60000)} min.`);
}

export function wakeDotAgentWorker() {
  if (!dotWorkerRuntimeEnabled()) return undefined;
  return scheduleTick();
}

/** Estado do worker para observabilidade em `/api/dot/status`. */
export function getDotAgentWorkerStatus() {
  return {
    disabled: process.env.DOT_AGENT_WORKER_ENABLED === '0',
    timer_active: Boolean(timer),
    running,
    in_flight: Boolean(tickInFlight),
    stopped,
    interval_ms: Math.max(60_000, Number(process.env.DOT_AGENT_WORKER_INTERVAL_MS || 300_000)),
  };
}

export function stopDotAgentWorker() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Para o worker e aguarda (limitado) o tick em andamento — qualquer um:
 * o de inicialização, o de timer ou o acordado. O encerramento gracioso só
 * fecha o pool depois desta promessa assentar.
 *
 * O worker avança etapas determinísticas dentro de transações e com lock
 * durável; interromper um tick no meio deixa a missão em `working`, que o
 * próximo boot retoma. Ainda assim, o encerramento gracioso tenta terminar o
 * tick atual antes de fechar o pool do PostgreSQL — fechar o banco com uma
 * consulta em voo é o caminho mais curto para os erros de reconexão vistos
 * no Render.
 *
 * O worker NÃO toca o ledger do orçamento: reservas ambíguas do Dot
 * (`dot_budget_reservations` com `sent_at`) são duráveis e só mudam por
 * `finalize`/`reconcile` — o drain não as libera.
 */
export async function stopDotAgentWorkerAndDrain(timeoutMs = 5_000): Promise<{ drained: boolean; running: boolean }> {
  stopped = true;
  stopDotAgentWorker();
  const inFlight = tickInFlight;
  if (!inFlight) return { drained: true, running };
  let timedOut = false;
  const guard = new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      timedOut = true;
      resolve();
    }, Math.max(0, timeoutMs));
    if (typeof (t as any).unref === 'function') (t as any).unref();
  });
  await Promise.race([inFlight.catch(() => undefined), guard]);
  return { drained: !timedOut, running };
}
