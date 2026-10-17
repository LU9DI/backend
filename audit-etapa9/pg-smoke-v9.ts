/**
 * ETAPA 9 — smoke dos 5 defeitos PostgreSQL na árvore portada (backend canônico 1.3.0 + DOT).
 *
 * Executa os fluxos reais do DOT contra o PostgreSQL descartável
 * (container local filtra-pg-etapa9, porta 55432) e emite um VEREDITO por
 * defeito corrigido na Etapa 9:
 *
 *   D1. objetivo persistido (id real, não NaN) — createDotAgentGoal
 *   D2. missão sem órfãos/etapas ausentes (ids reais) — createMissionForGoal
 *   D3. permissões com parâmetros tipados (sem "could not determine data type") — setDotPermission
 *   D4. transação atômica de verdade (rollback desfaz mesmo sob carga) — withDbTransaction
 *   D5. caseId real no fluxo de execução (sem "Caso interno criado (#NaN)")
 *
 * Uso (PowerShell, com o container no ar):
 *   $env:DATABASE_URL='postgres://postgres:etapa9audit@localhost:55432/filtra_audit'
 *   $env:PGSSL='0'
 *   node_modules\.bin\tsx.cmd audit-etapa9\pg-smoke-v9.ts
 */
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'auditoria-etapa9-secret-nao-usar-em-producao';

import { initDB, getDb, withDbTransaction } from '../lib/db.js';
import { ensureDotAccessSchema, setDotPermission } from '../services/dotAccessControl.js';
import { getDotPreferences, saveDotPreferences } from '../services/dotPreferences.js';
import { listDotEvents, runDotMonitor } from '../services/dotMonitor.js';
import { createDotAgentGoal } from '../services/dotAgent.js';
import { createMissionForGoal, ensureMissionTables, listDotAgentMissionSteps } from '../services/dotAgentMissions.js';
import { runCurrentDotMissionStep } from '../services/dotAgentMissionRunner.js';
import { listDotActions, approveDotAction, executeDotAction } from '../services/dotActionQueue.js';

function out(label: string, value: unknown) {
  console.log(`AUDIT ${label} ${JSON.stringify(value)}`);
}

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const verdicts: Record<string, { ok: boolean; detalhe: string }> = {};

function verdict(defect: string, ok: boolean, detalhe: string) {
  verdicts[defect] = { ok, detalhe };
  out(`veredito-${defect}`, { ok, detalhe });
}

async function seedEmpresa(plan = 'rei'): Promise<string> {
  const db = getDb();
  const emp = 'pg-smoke9-' + crypto.randomUUID().slice(0, 8);
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
    [
      emp,
      'cnpj-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14),
      'Empresa PG Smoke 9',
      'slug-' + emp.slice(-8),
      'ativo',
      plan,
      now,
      new Date(Date.now() + 30 * 864e5).toISOString(),
    ],
  );
  return emp;
}

async function seedReviews(emp: string, count: number): Promise<void> {
  const db = getDb();
  for (let i = 0; i < count; i += 1) {
    await db.run(
      'INSERT INTO reviews (empresa_id,name,rating,comment,ai_tags,is_test,createdAt) VALUES (?,?,?,?,?,0,?)',
      [
        emp,
        'Cliente',
        i < count - 2 ? 1 : 2,
        'Demora no atendimento e tempo de espera longo',
        JSON.stringify(['tempo de espera']),
        new Date().toISOString(),
      ],
    );
  }
}

async function main() {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!/^postgres/i.test(url)) {
    console.error('DATABASE_URL precisa apontar para o PostgreSQL isolado (postgres://...).');
    process.exit(2);
  }

  await initDB();
  const db = getDb();
  out('driver', { url: 'postgres (container isolado)', pgssl: process.env.PGSSL || '(default)' });

  // ── D4: transação atômica de verdade (rollback desfaz; inclusive sob carga) ──
  await listDotEvents('pg-smoke9-warmup'); // garante dot_events antes do probe
  const txEmp = 'pg-tx9-' + crypto.randomUUID().slice(0, 8);
  try {
    await withDbTransaction(async (tx) => {
      await tx.run(
        'INSERT INTO dot_events (empresa_id,type,severity,title,details,created_at) VALUES (?,?,?,?,?,?)',
        [txEmp, 'tx_probe', 'warning', 'probe', 'probe', new Date().toISOString()],
      );
      throw new Error('rollback-probe');
    });
  } catch {
    /* rollback esperado */
  }
  const afterRollback = await db.get('SELECT COUNT(*)::int AS n FROM dot_events WHERE empresa_id = ?', [txEmp]);
  const rollbackOk = Number(afterRollback?.n ?? -1) === 0;

  const tx2Emp = 'pg-tx9b-' + crypto.randomUUID().slice(0, 8);
  const noise: Array<Promise<unknown>> = [];
  for (let i = 0; i < 30; i += 1) {
    noise.push(
      (async () => {
        for (let k = 0; k < 12; k += 1) {
          try {
            await db.get('SELECT COUNT(*)::int AS n FROM dot_events');
          } catch {
            /* carga best-effort */
          }
        }
      })(),
    );
  }
  const loadProbe = (async () => {
    try {
      await withDbTransaction(async (tx) => {
        await tx.run(
          'INSERT INTO dot_events (empresa_id,type,severity,title,details,created_at) VALUES (?,?,?,?,?,?)',
          [tx2Emp, 'tx_probe_load', 'warning', 'probe', 'probe', new Date().toISOString()],
        );
        throw new Error('rollback-probe-load');
      });
    } catch {
      /* rollback esperado */
    }
  })();
  await Promise.allSettled([loadProbe, ...noise]);
  const afterLoad = await db.get('SELECT COUNT(*)::int AS n FROM dot_events WHERE empresa_id = ?', [tx2Emp]);
  const rollbackLoadOk = Number(afterLoad?.n ?? -1) === 0;
  verdict(
    'D4-transacao-atomica',
    rollbackOk && rollbackLoadOk,
    `rollback simples=${Number(afterRollback?.n)} linhas, rollback sob carga=${Number(afterLoad?.n)} linhas (esperado 0/0)`,
  );

  // ── fluxo funcional: empresa, preferências, avaliações, permissões (D3) ──
  await ensureDotAccessSchema();
  const emp = await seedEmpresa('rei');
  await saveDotPreferences(emp, { autonomy: 'proativo', prepareActionsAutomatically: true });
  await seedReviews(emp, 6);

  let permissionsOk = true;
  let permissionsError = '';
  try {
    for (const [resource, action] of [
      ['filtra', 'read'],
      ['filtra', 'execute'],
      ['operations', 'create'],
      ['operations', 'execute'],
    ] as const) {
      // Escopo da empresa (user_id NULL) — era aqui que o "? IS NULL" quebrava no PG.
      await setDotPermission(emp, { resource, action, granted: true, grantedBy: 'auditoria-etapa9' });
      // Escopo de usuário + caminho de atualização (segunda chamada = UPDATE).
      await setDotPermission(emp, { resource, action, granted: true, grantedBy: 'auditoria-etapa9', userId: 'user-teste' });
      await setDotPermission(emp, { resource, action, granted: true, grantedBy: 'auditoria-etapa9', userId: 'user-teste' });
    }
    const rows = await db.all(
      'SELECT resource, action, granted FROM dot_agent_permissions WHERE empresa_id = ? ORDER BY resource, action, user_id NULLS FIRST',
      [emp],
    );
    if (rows.length < 8) throw new Error(`esperava >= 8 permissões, encontrou ${rows.length}`);
  } catch (e) {
    permissionsOk = false;
    permissionsError = err(e);
  }
  verdict('D3-permissoes-tipadas', permissionsOk, permissionsOk ? 'empresa e usuário (com atualização) sem erro de tipo de parâmetro' : permissionsError);

  const monitor = await runDotMonitor(emp);
  out('monitor', {
    ok: monitor.ok,
    events: monitor.events?.length ?? 0,
    decisions: monitor.decisions?.length ?? 0,
    prepared_actions: monitor.prepared_actions?.length ?? 0,
    average: monitor.average ?? null,
  });

  // ── D1: objetivo persistido com id real ──
  let goalId = 0;
  let goalError = '';
  try {
    const goal = await createDotAgentGoal(emp, { title: 'Objetivo PG smoke 9' });
    goalId = Number(goal?.id);
    if (!Number.isFinite(goalId) || goalId <= 0) throw new Error(`id inválido devolvido: ${String(goal?.id)}`);
    const persisted = await db.get('SELECT id, title FROM dot_agent_goals WHERE id = ? AND empresa_id = ?', [goalId, emp]);
    if (!persisted) throw new Error('linha do objetivo não encontrada pelo id devolvido');
  } catch (e) {
    goalError = err(e);
  }
  verdict('D1-objetivo-persistido', goalId > 0 && !goalError, goalId > 0 ? `objetivo #${goalId} persistido e relido` : goalError);

  // ── D2: missão sem órfãos, com etapas ligadas ao id real ──
  let missionId = 0;
  let missionError = '';
  let stepsCount = 0;
  let orphans = 0;
  if (goalId > 0) {
    try {
      await ensureMissionTables();
      const mission = await createMissionForGoal(emp, goalId, 'Missão PG smoke 9');
      missionId = Number(mission?.id);
      if (!Number.isFinite(missionId) || missionId <= 0) throw new Error(`id inválido devolvido: ${String(mission?.id)}`);
      const steps = await listDotAgentMissionSteps(emp, missionId);
      stepsCount = steps.length;
      if (stepsCount !== 6) throw new Error(`esperava 6 etapas, encontrou ${stepsCount}`);
      const mismatched = steps.filter((s) => Number(s.mission_id) !== missionId);
      if (mismatched.length > 0) throw new Error(`${mismatched.length} etapa(s) com mission_id divergente (órfãs)`);
      const missionsForGoal = await db.get('SELECT COUNT(*)::int AS n FROM dot_agent_missions WHERE goal_id = ? AND empresa_id = ?', [goalId, emp]);
      orphans = Number(missionsForGoal?.n ?? -1) === 1 ? 0 : 1;
      if (orphans) throw new Error('missão não encontrada pelo goal_id');
    } catch (e) {
      missionError = err(e);
    }
  } else {
    missionError = 'objetivo não criado (D1 falhou)';
  }
  verdict(
    'D2-missao-sem-orfaos',
    missionId > 0 && stepsCount === 6 && orphans === 0,
    missionId > 0 ? `missão #${missionId} com ${stepsCount} etapas ligadas e goal_id consistente` : missionError,
  );

  // ── runner até a barreira de aprovação ──
  const runResults: Array<Record<string, unknown>> = [];
  if (missionId > 0) {
    for (let i = 0; i < 8; i += 1) {
      try {
        const r = await runCurrentDotMissionStep(emp, missionId);
        runResults.push({
          blocked: r?.blocked ?? null,
          executed: r?.executed ?? null,
          status: r?.mission?.status ?? null,
          step: r?.mission?.current_step ?? null,
        });
        if (!r || r.blocked) break;
      } catch (e) {
        runResults.push({ error: err(e) });
        break;
      }
    }
  }
  out('runner-ate-aprovacao', runResults);

  // ── D5: aprovação + execução sem caseId NaN ──
  let caseIds: number[] = [];
  let caseError = '';
  let approvalActionId = 0;
  if (missionId > 0) {
    try {
      const actions = await listDotActions(emp);
      const missionRow = await db.get('SELECT approval_action_id FROM dot_agent_missions WHERE id = ? AND empresa_id = ?', [missionId, emp]);
      approvalActionId = Number(missionRow?.approval_action_id);
      const prepared =
        actions.find((a) => a?.status === 'prepared' && Number.isInteger(approvalActionId) && a?.id === approvalActionId) ??
        actions.find((a) => a?.status === 'prepared');
      out('fila-acoes', actions.map((a) => ({ id: a?.id, status: a?.status, action: a?.action })));
      if (!prepared) throw new Error('nenhuma ação preparada para aprovar/executar');
      const ap = await approveDotAction(emp, prepared.id);
      out('aprovar', ap ? { id: ap.id, status: ap.status, executed: ap.executed } : null);
      const ex = await executeDotAction(emp, prepared.id, null);
      out('executar', {
        ok: ex.ok,
        id: ex.id,
        status: ex.status,
        simulated: ex.simulated,
        executor: ex.executor,
        reason: ex.reason ?? null,
      });
      if (ex.reason && /#NaN|NaN/.test(String(ex.reason))) throw new Error(`reason com NaN: ${ex.reason}`);
      const cases = await db.all('SELECT id, status FROM dot_internal_cases WHERE empresa_id = ?', [emp]);
      caseIds = cases.map((c) => Number(c.id));
      if (caseIds.some((id) => !Number.isFinite(id) || id <= 0)) throw new Error(`caseId inválido: ${JSON.stringify(caseIds)}`);
      if (caseIds.length === 0) throw new Error('nenhum caso interno registrado após a execução');
      const resumed = await runCurrentDotMissionStep(emp, missionId);
      out('retomada-pos-execucao', {
        blocked: resumed?.blocked ?? null,
        status: resumed?.mission?.status ?? null,
        step: resumed?.mission?.current_step ?? null,
      });
    } catch (e) {
      caseError = err(e);
    }
  } else {
    caseError = 'missão não criada (D2 falhou)';
  }

  // Varredura final por "#NaN" em saídas de etapa.
  const nanRows = await db.all(
    "SELECT id FROM dot_agent_mission_steps WHERE empresa_id = ? AND output LIKE '%#NaN%'",
    [emp],
  );
  verdict(
    'D5-caseid-real',
    caseIds.length > 0 && caseIds.every((id) => Number.isFinite(id) && id > 0) && nanRows.length === 0 && !caseError,
    caseError || `casos internos com id real: ${JSON.stringify(caseIds)}; ocorrências de #NaN: ${nanRows.length}`,
  );

  // ── estado final das etapas ──
  if (missionId > 0) {
    const steps = await listDotAgentMissionSteps(emp, missionId);
    out('etapas-finais', steps.map((s) => ({
      type: s.type,
      status: s.status,
      output: s.output ? String(s.output).slice(0, 70) : null,
    })));
  }

  const allOk = Object.values(verdicts).every((v) => v.ok);
  out('V9-VEREDITO', {
    empresa: emp,
    objetivo: goalId || null,
    missao: missionId || null,
    acao_aprovacao: Number.isFinite(approvalActionId) ? approvalActionId : null,
    casos_internos: caseIds,
    defeitos: Object.fromEntries(Object.entries(verdicts).map(([k, v]) => [k, v.ok ? 'CORRIGIDO' : 'FALHA'])),
    todos_corrigidos: allOk,
  });
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error('FALHA-GERAL:', err(e));
  process.exit(1);
});
