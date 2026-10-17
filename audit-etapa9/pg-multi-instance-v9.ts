/**
 * ETAPA 9 — concorrência entre PROCESSOS (cenário multi-instância) no PostgreSQL isolado.
 *
 * Adaptação do script audit-etapa8/pg-multi-instance.ts para a árvore portada
 * (backend canônico 1.3.0 + DOT). Verifica o que acontece quando DOIS processos
 * (duas instâncias da API) executam o mesmo trabalho ao mesmo tempo contra o
 * mesmo Postgres:
 *   - race-monitor: duas instâncias rodam o monitor da mesma empresa;
 *   - race-mission: duas instâncias executam a etapa da mesma missão;
 *   - crash-hold/expire-lock: recuperação após queda (lock durável com TTL).
 *
 * Subcomandos:
 *   seed-monitor <n>                     cria n empresas com sinal de avaliação
 *   race-monitor <empresaId>             dispara 2 processos no mesmo instante
 *   monitor-once <empresaId> <startMs>   (interno) executa o monitor no instante marcado
 *   check-monitor <empresaId>            conta eventos/decisões/ações e duplicatas
 *   seed-mission <empresaId>             cria objetivo+missão+etapas via SQL puro
 *   race-mission <empresaId> <missaoId>  dispara 2 processos no mesmo instante
 *   step-once <empresaId> <missaoId> <startMs>  (interno) executa 1 etapa no instante marcado
 *   check-mission <empresaId> <missaoId> estado da missão e das etapas
 *   crash-hold-monitor <empresaId>       (interno) adquire o lock do monitor e morre sem liberar
 *   lock-state <nome>                    mostra o lock durável
 *   expire-lock <nome>                   força expiração do lock (simula passagem do TTL)
 *
 * Uso (PowerShell, com o container no ar):
 *   $env:DATABASE_URL='postgres://postgres:etapa9audit@localhost:55432/filtra_audit'
 *   $env:PGSSL='0'
 *   node_modules\.bin\tsx.cmd audit-etapa9\pg-multi-instance-v9.ts <subcomando> ...
 */
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'auditoria-etapa9-secret-nao-usar-em-producao';

import { initDB, getDb } from '../lib/db.js';
import { ensureDotAgentSchema } from '../services/dotAgent.js';
import { ensureMissionTables } from '../services/dotAgentMissions.js';
import { saveDotPreferences } from '../services/dotPreferences.js';
import { runDotMonitor } from '../services/dotMonitor.js';
import { runCurrentDotMissionStep } from '../services/dotAgentMissionRunner.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function out(label: string, value: unknown) {
  console.log(`AUDIT ${label} ${JSON.stringify(value)}`);
}

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const SELF = fileURLToPath(import.meta.url);

function spawnSelf(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', SELF, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
    child.stdout.on('data', (d) => {
      buffer += String(d);
    });
    child.stderr.on('data', (d) => {
      buffer += String(d);
    });
    child.on('close', (code) => resolve({ code, output: buffer }));
  });
}

async function waitBarrier(startMs: number) {
  while (Date.now() < startMs) await sleep(4);
}

async function seedMonitorEmpresas(count: number) {
  const db = getDb();
  for (let i = 0; i < count; i += 1) {
    const emp = 'pg-mi9-' + crypto.randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    await db.run(
      'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
      [
        emp,
        'cnpj-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14),
        'Empresa MultiInstancia',
        'slug-' + emp.slice(-8),
        'ativo',
        'rei',
        now,
        new Date(Date.now() + 30 * 864e5).toISOString(),
      ],
    );
    await saveDotPreferences(emp, { autonomy: 'proativo', prepareActionsAutomatically: true });
    for (let r = 0; r < 6; r += 1) {
      await db.run(
        'INSERT INTO reviews (empresa_id,name,rating,comment,ai_tags,is_test,createdAt) VALUES (?,?,?,?,?,0,?)',
        [
          emp,
          'Cliente',
          r < 4 ? 1 : 2,
          'Demora no atendimento e tempo de espera longo',
          JSON.stringify(['tempo de espera']),
          new Date().toISOString(),
        ],
      );
    }
    console.log(`EMP ${emp}`);
  }
}

async function checkMonitor(emp: string) {
  const db = getDb();
  const events = await db.all(
    'SELECT id, type, created_at FROM dot_events WHERE empresa_id = ? AND acknowledged_at IS NULL ORDER BY id ASC',
    [emp],
  );
  const dupGroups = await db.all(
    'SELECT type, COUNT(*)::int AS n FROM dot_events WHERE empresa_id = ? AND acknowledged_at IS NULL GROUP BY type HAVING COUNT(*) > 1',
    [emp],
  );
  const decisions = await db.get('SELECT COUNT(*)::int AS n FROM dot_decisions WHERE empresa_id = ?', [emp]);
  const actions = await db.get('SELECT COUNT(*)::int AS n FROM dot_action_queue WHERE empresa_id = ?', [emp]);
  let locks: unknown[] = [];
  try {
    locks = await db.all('SELECT name, locked_by, expires_at FROM dot_locks WHERE name = ?', [`monitor:${emp}`]);
  } catch {
    /* tabela de locks pode não existir antes da correção */
  }
  return {
    eventos: events.map((e) => ({ id: Number(e.id), type: String(e.type) })),
    duplicatas_por_tipo: dupGroups.map((d) => ({ type: String(d.type), n: Number(d.n) })),
    decisoes: decisions?.n ?? null,
    acoes: actions?.n ?? null,
    locks_do_monitor: locks,
  };
}

async function raceMonitor(emp: string) {
  const startMs = Date.now() + 4000;
  const [a, b] = await Promise.all([
    spawnSelf(['monitor-once', emp, String(startMs)]),
    spawnSelf(['monitor-once', emp, String(startMs)]),
  ]);
  out('race-monitor-processos', {
    processo_a_exit: a.code,
    processo_b_exit: b.code,
    processo_a_resultado: extractAudit(a.output),
    processo_b_resultado: extractAudit(b.output),
  });
  const after = await checkMonitor(emp);
  out('race-monitor-resultado', after);
  // Terceiro monitor sequencial: a duplicata, se existir, já está commitada.
  await runDotMonitor(emp);
  const db = getDb();
  const eventsAfter = await db.get(
    'SELECT COUNT(*)::int AS n FROM dot_events WHERE empresa_id = ? AND acknowledged_at IS NULL',
    [emp],
  );
  out('race-monitor-pos-sequencial', { eventos_apos_terceiro_monitor: eventsAfter?.n ?? null });
}

function extractAudit(output: string): unknown {
  const lines = output
    .split(/\r?\n/)
    .filter((l) => l.startsWith('AUDIT '))
    .map((l) => l.slice(6));
  if (lines.length === 0) {
    return output.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(-6);
  }
  return lines.map((l) => {
    const idx = l.indexOf(' ');
    return idx === -1 ? l : l.slice(0, idx) + ': ' + l.slice(idx + 1);
  });
}

async function monitorOnce(emp: string, startMs: number) {
  await initDB();
  await waitBarrier(startMs);
  const startedAt = Date.now();
  const result = await runDotMonitor(emp);
  out('monitor-once', {
    started_at_ms: startedAt,
    skipped: Boolean(result.skipped),
    reason: result.reason ?? null,
    events: Array.isArray(result.events) ? result.events.map((e) => e.id) : [],
    decisions: Array.isArray(result.decisions) ? result.decisions.map((d) => d.id) : [],
    actions: Array.isArray(result.prepared_actions) ? result.prepared_actions.map((a) => a.id) : [],
  });
  process.exit(0);
}

async function seedMission(emp: string) {
  const db = getDb();
  await ensureDotAgentSchema();
  await ensureMissionTables();
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO dot_agent_goals (empresa_id,title,description,status,progress,source,created_at,updated_at,last_activity_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [emp, 'Objetivo multi-instância', null, 'active', 0, 'owner', now, now, now],
  );
  const g = await db.get('SELECT id FROM dot_agent_goals WHERE empresa_id = ? ORDER BY id DESC LIMIT 1', [emp]);
  const goalId = Number(g?.id);
  await db.run(
    'INSERT INTO dot_agent_missions (goal_id,empresa_id,title,status,current_step,total_steps,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [goalId, emp, 'Missão multi-instância', 'planned', 0, 6, now, now],
  );
  const m = await db.get('SELECT id FROM dot_agent_missions WHERE empresa_id = ? ORDER BY id DESC LIMIT 1', [emp]);
  const missionId = Number(m?.id);
  const titles: Array<[string, string]> = [
    ['observe', 'Observar o contexto disponível'],
    ['investigate', 'Investigar o que está impedindo o objetivo'],
    ['recommend', 'Recomendar o próximo caminho'],
    ['prepare', 'Preparar o trabalho necessário'],
    ['approval', 'Aguardar aprovação quando necessário'],
    ['result', 'Acompanhar o resultado'],
  ];
  for (const [type, title] of titles) {
    await db.run(
      'INSERT INTO dot_agent_mission_steps (mission_id,empresa_id,type,status,title,created_at) VALUES (?,?,?,?,?,?)',
      [missionId, emp, type, 'pending', title, now],
    );
  }
  console.log(`MISSION ${missionId}`);
}

async function checkMission(emp: string, missionId: number) {
  const db = getDb();
  const mission = await db.get('SELECT id, current_step, total_steps, status FROM dot_agent_missions WHERE id = ? AND empresa_id = ?', [
    missionId,
    emp,
  ]);
  const steps = await db.all(
    'SELECT id, type, status, output FROM dot_agent_mission_steps WHERE mission_id = ? AND empresa_id = ? ORDER BY id ASC',
    [missionId, emp],
  );
  let locks: unknown[] = [];
  try {
    locks = await db.all('SELECT name, locked_by, expires_at FROM dot_locks WHERE name = ?', [`mission:${emp}:${missionId}`]);
  } catch {
    /* tabela de locks pode não existir antes da correção */
  }
  return {
    missao: mission ? { current_step: Number(mission.current_step), status: String(mission.status) } : null,
    etapas: steps.map((s) => ({
      id: Number(s.id),
      type: String(s.type),
      status: String(s.status),
      output: s.output ? String(s.output).slice(0, 80) : null,
    })),
    locks_da_missao: locks,
  };
}

async function raceMission(emp: string, missionId: number) {
  const startMs = Date.now() + 4000;
  const [a, b] = await Promise.all([
    spawnSelf(['step-once', emp, String(missionId), String(startMs)]),
    spawnSelf(['step-once', emp, String(missionId), String(startMs)]),
  ]);
  out('race-mission-processos', {
    processo_a_exit: a.code,
    processo_b_exit: b.code,
    processo_a_resultado: extractAudit(a.output),
    processo_b_resultado: extractAudit(b.output),
  });
  out('race-mission-resultado', await checkMission(emp, missionId));
}

async function stepOnce(emp: string, missionId: number, startMs: number) {
  await initDB();
  await waitBarrier(startMs);
  const startedAt = Date.now();
  const r = await runCurrentDotMissionStep(emp, missionId);
  out('step-once', {
    started_at_ms: startedAt,
    blocked: r?.blocked ?? null,
    executed: r?.executed ?? null,
    step_id: r?.step?.id ?? null,
    step_type: r?.step?.type ?? null,
    current_step_depois: r?.mission?.current_step ?? null,
    status_depois: r?.mission?.status ?? null,
    reason: r?.reason ?? null,
    output: r?.output ? String(r.output).slice(0, 90) : null,
  });
  process.exit(0);
}

async function raceCrossMonitor(emp1: string, emp2: string) {
  const startMs = Date.now() + 4000;
  const [a, b] = await Promise.all([
    spawnSelf(['monitor-once', emp1, String(startMs)]),
    spawnSelf(['monitor-once', emp2, String(startMs)]),
  ]);
  out('race-cross-monitor-processos', {
    empresa_a: emp1,
    empresa_b: emp2,
    processo_a_exit: a.code,
    processo_b_exit: b.code,
    processo_a_resultado: extractAudit(a.output),
    processo_b_resultado: extractAudit(b.output),
  });
  out('race-cross-monitor-estado', {
    empresa_a: await checkMonitor(emp1),
    empresa_b: await checkMonitor(emp2),
  });
}

async function crashHoldMonitor(emp: string) {
  await initDB();
  const { acquireDotLock } = await import('../services/dotCoordination.js');
  const owner = await acquireDotLock(`monitor:${emp}`, 60_000);
  out('crash-hold', { owner_adquirido: Boolean(owner) });
  // Morre SEM liberar o lock: simula uma instância que caiu no meio do trabalho.
  process.exit(7);
}

async function lockState(name: string) {
  const db = getDb();
  try {
    const rows = await db.all('SELECT name, locked_by, expires_at FROM dot_locks WHERE name = ?', [name]);
    out('lock-state', rows);
  } catch (e) {
    out('lock-state-FALHA', { error: err(e) });
  }
}

async function expireLock(name: string) {
  const db = getDb();
  try {
    const result = await db.run('UPDATE dot_locks SET expires_at = ? WHERE name = ?', [
      new Date(Date.now() - 60_000).toISOString(),
      name,
    ]);
    out('expire-lock', { changes: Number((result as { changes?: number }).changes ?? 0) });
  } catch (e) {
    out('expire-lock-FALHA', { error: err(e) });
  }
}

async function main() {
  const cmd = process.argv[2] || '';
  await initDB();

  if (cmd === 'seed-monitor') {
    await seedMonitorEmpresas(Number(process.argv[3] || 1));
  } else if (cmd === 'race-monitor') {
    await raceMonitor(String(process.argv[3]));
  } else if (cmd === 'monitor-once') {
    await monitorOnce(String(process.argv[3]), Number(process.argv[4]));
  } else if (cmd === 'check-monitor') {
    out('check-monitor', await checkMonitor(String(process.argv[3])));
  } else if (cmd === 'seed-mission') {
    await seedMission(String(process.argv[3]));
  } else if (cmd === 'race-mission') {
    await raceMission(String(process.argv[3]), Number(process.argv[4]));
  } else if (cmd === 'race-cross-monitor') {
    await raceCrossMonitor(String(process.argv[3]), String(process.argv[4]));
  } else if (cmd === 'step-once') {
    await stepOnce(String(process.argv[3]), Number(process.argv[4]), Number(process.argv[5]));
  } else if (cmd === 'check-mission') {
    out('check-mission', await checkMission(String(process.argv[3]), Number(process.argv[4])));
  } else if (cmd === 'crash-hold-monitor') {
    await crashHoldMonitor(String(process.argv[3]));
  } else if (cmd === 'lock-state') {
    await lockState(String(process.argv[3]));
  } else if (cmd === 'expire-lock') {
    await expireLock(String(process.argv[3]));
  } else {
    console.error('subcomando desconhecido: ' + cmd);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FALHA-GERAL:', err(e));
  process.exit(1);
});
