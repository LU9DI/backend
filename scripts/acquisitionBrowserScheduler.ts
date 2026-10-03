import 'dotenv/config';
import { spawn } from 'node:child_process';
import path from 'node:path';

const INTERVAL_MS = Math.max(60_000, Number(process.env.ACQUISITION_BROWSER_INTERVAL_MS || 300_000));
const WORKER_TIMEOUT_MS = Math.max(45_000, Number(process.env.ACQUISITION_BROWSER_WORKER_TIMEOUT_MS || 110_000));

let cycle = 0;
let active: ReturnType<typeof spawn> | null = null;

function startCycle() {
  cycle += 1;
  const script = path.join(process.cwd(), 'scripts', 'acquisitionBrowserOnce.ts');
  const tsx = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const startedAt = Date.now();
  const child = spawn(process.execPath, [tsx, script], {
    env: {
      ...process.env,
      ACQUISITION_BROWSER_BOT: '1',
      ACQUISITION_BROWSER_CHILD: '1',
    },
    stdio: 'inherit',
  });
  active = child;
  console.log('[acquisition-browser] scheduler cycle start', { cycle, pid: child.pid, interval_ms: INTERVAL_MS });

  const watchdog = setTimeout(() => {
    if (active !== child) return;
    console.error('[acquisition-browser] scheduler worker timeout; killing child', {
      cycle,
      pid: child.pid,
      elapsed_ms: Date.now() - startedAt,
      timeout_ms: WORKER_TIMEOUT_MS,
    });
    try { child.kill('SIGKILL'); } catch {}
  }, WORKER_TIMEOUT_MS);

  child.on('error', (error) => {
    clearTimeout(watchdog);
    if (active === child) active = null;
    console.error('[acquisition-browser] scheduler worker error', { cycle, message: error?.message || String(error) });
  });

  child.on('exit', (code, signal) => {
    clearTimeout(watchdog);
    if (active === child) active = null;
    console.log('[acquisition-browser] scheduler cycle end', {
      cycle,
      pid: child.pid,
      code,
      signal,
      duration_ms: Date.now() - startedAt,
    });
  });
}

console.log('[acquisition-browser] isolated scheduler online', {
  interval_ms: INTERVAL_MS,
  worker_timeout_ms: WORKER_TIMEOUT_MS,
  pid: process.pid,
});

startCycle();

setInterval(() => {
  if (active) {
    console.log('[acquisition-browser] isolated scheduler heartbeat', {
      cycle,
      active_pid: active.pid,
    });
  } else {
    startCycle();
  }
}, INTERVAL_MS);
