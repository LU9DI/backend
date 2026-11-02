/**
 * Teste PostgreSQL real: dois processos Node, pools e conexões independentes.
 * Executado isoladamente via npm run test:postgres.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { initDB, getDb, closeDB } from '../lib/db.js';

function runWorker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./helpers/prepare-dot-action.pg.ts', import.meta.url)), ...args], {
      cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`worker exit ${code}: ${stderr}`)));
  });
}

test('duas instâncias PostgreSQL concorrentes retornam a mesma ação sem auditoria duplicada', async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL de teste é obrigatória');
  process.env.NODE_ENV = 'test';
  await initDB();
  const db = getDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS dot_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      priority TEXT NOT NULL,
      severity TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      options_json TEXT NOT NULL,
      requires_approval INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    )
  `);
  const empresaId = `pg-concurrency-${crypto.randomUUID()}`;
  const options = [{ id: 'opcao_pg', title: 'Teste', action: 'priorizar_e_resolver', risk: 'medium' }];
  const seeded = await db.run(
    `INSERT INTO dot_decisions
      (empresa_id,event_id,type,priority,severity,reason,evidence_json,recommendation,options_json,requires_approval,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    [empresaId, Date.now(), 'crise_reputacional', 'high', 'critical', 'pg concurrency', '[]', 'teste', JSON.stringify(options), 1, 'pending', new Date().toISOString()],
  );
  const decisionId = Number(seeded.lastID);
  assert.ok(decisionId > 0, 'decisão de teste deve ser criada');
  try {
    const args = [empresaId, String(decisionId), 'opcao_pg'];
    const [a, b] = await Promise.all([runWorker(args), runWorker(args)]);
    const resultA = JSON.parse(a.stdout);
    const resultB = JSON.parse(b.stdout);
    assert.equal(resultA.id, resultB.id, 'ambas as instâncias devem receber o mesmo ID idempotente');
    const actions = await db.all('SELECT id,status FROM dot_action_queue WHERE empresa_id = ? AND decision_id = ?', [empresaId, decisionId]);
    assert.equal(actions.length, 1, 'deve existir exatamente uma ação');
    assert.equal(String(actions[0].status), 'prepared');
    const audits = await db.all("SELECT id FROM dot_action_audit WHERE empresa_id = ? AND decision_id = ? AND event = 'prepared'", [empresaId, decisionId]);
    assert.equal(audits.length, 1, 'deve existir exatamente um evento prepared');
  } finally {
    await db.run('DELETE FROM dot_action_audit WHERE empresa_id = ?', [empresaId]);
    await db.run('DELETE FROM dot_action_queue WHERE empresa_id = ?', [empresaId]);
    await db.run('DELETE FROM dot_decisions WHERE empresa_id = ?', [empresaId]);
    await closeDB();
  }
});
