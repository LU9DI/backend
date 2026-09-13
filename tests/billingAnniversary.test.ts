import assert from 'node:assert/strict';
import test from 'node:test';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { activatePlan, proximoRelatorioMensal } from '../services/billingService.js';

async function memDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE empresas (
      id TEXT PRIMARY KEY,
      cnpj TEXT,
      nome_empresa TEXT,
      slug TEXT,
      status TEXT,
      plan TEXT,
      expira_em TEXT,
      cancel_at_period_end INTEGER DEFAULT 0,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      report_next_due_at TEXT,
      report_last_sent_at TEXT
    );
    CREATE TABLE usuarios (
      id TEXT PRIMARY KEY,
      empresa_id TEXT,
      email TEXT,
      cnpj TEXT,
      nome_funcionario TEXT,
      senha_hash TEXT
    );
  `);
  await db.run(
    `INSERT INTO empresas (id, cnpj, nome_empresa, status, plan) VALUES (?,?,?,?,?)`,
    ['emp-1', '123', 'Teste SA', 'trial', 'trial']
  );
  return db;
}

test('proximoRelatorioMensal avança ~1 mês', () => {
  const from = new Date('2026-09-12T15:00:00.000Z');
  const next = new Date(proximoRelatorioMensal(from));
  assert.ok(next.getTime() > from.getTime());
  // em torno de 28–32 dias
  const days = (next.getTime() - from.getTime()) / 86400000;
  assert.ok(days >= 27 && days <= 32, `days=${days}`);
});

test('webhook retry NÃO reseta report_next_due_at', async () => {
  const db = await memDb();
  const r1 = await activatePlan(db, 'emp-1', 'pro', 'cus_1', 'sub_1', null, { silent: true });
  const due1 = r1.report_next_due_at;
  assert.ok(due1);
  assert.equal(r1.anniversary_preserved, false);

  // retry mesmo subscription
  const r2 = await activatePlan(db, 'emp-1', 'pro', 'cus_1', 'sub_1', null, { silent: true });
  assert.equal(r2.anniversary_preserved, true);
  assert.equal(r2.report_next_due_at, due1);

  const row = await db.get('SELECT report_next_due_at, plan, status FROM empresas WHERE id=?', [
    'emp-1',
  ]);
  assert.equal(row.report_next_due_at, due1);
  assert.equal(row.plan, 'pro');
  assert.equal(row.status, 'ativo');
  await db.close();
});

test('upgrade Pro→Rei preserva aniversário', async () => {
  const db = await memDb();
  const r1 = await activatePlan(db, 'emp-1', 'pro', 'cus_1', 'sub_1', null, { silent: true });
  const due = r1.report_next_due_at;

  const r2 = await activatePlan(db, 'emp-1', 'rei', 'cus_1', 'sub_1', null, { silent: true });
  assert.equal(r2.anniversary_preserved, true);
  assert.equal(r2.report_next_due_at, due);
  assert.equal(r2.plan, 'rei');
  await db.close();
});

test('forceNewReportCycle recalcula aniversário', async () => {
  const db = await memDb();
  const r1 = await activatePlan(db, 'emp-1', 'pro', 'cus_1', 'sub_1', null, { silent: true });
  const due1 = r1.report_next_due_at;

  // simula “passou tempo” mexendo o due para o passado e forçando ciclo novo
  await db.run(`UPDATE empresas SET report_next_due_at = ? WHERE id = ?`, [
    '2020-01-01T00:00:00.000Z',
    'emp-1',
  ]);

  const r2 = await activatePlan(db, 'emp-1', 'pro', 'cus_1', 'sub_1', null, {
    silent: true,
    forceNewReportCycle: true,
  });
  assert.equal(r2.anniversary_preserved, false);
  assert.notEqual(r2.report_next_due_at, due1);
  assert.notEqual(r2.report_next_due_at, '2020-01-01T00:00:00.000Z');
  await db.close();
});
