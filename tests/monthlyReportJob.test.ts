/**
 * Job mensal: gera e persiste o snapshot por empresa/período e, com a entrega
 * externa desligada (padrão), não aciona nenhum canal externo. Com
 * MONTHLY_REPORT_EXTERNAL_DELIVERY=1 e sem n8n configurado, apenas registra
 * distribuição indisponível sem falhar o processamento.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { rmSync } from 'node:fs';
import { test } from 'node:test';

let sqliteAvailable = true;
try {
  await import('sqlite3');
  await import('sqlite');
} catch {
  sqliteAvailable = false;
}

import { initDB, getDb } from '../lib/db.js';
import { ensureReviewTreatmentColumns } from '../lib/lgpd.js';
import { ensureUnidadesSchema } from '../lib/unidades.js';
import { runMonthlyReportJob } from '../routes/monthlyReportJobsRoutes.js';

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = '/tmp/filtra-monthly-report-job-test.sqlite';
delete process.env.N8N_WEBHOOK_URL;
delete process.env.MONTHLY_REPORT_EXTERNAL_DELIVERY;

const jobTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !sqliteAvailable }, fn);

let ready = false;

async function setup() {
  if (ready) return;
  rmSync('/tmp/filtra-monthly-report-job-test.sqlite', { force: true });
  await initDB();
  const db = getDb();
  await ensureReviewTreatmentColumns(db);
  await ensureUnidadesSchema(db);
  for (const ddl of ['sentiment TEXT', 'origin TEXT', 'unidade_id TEXT']) {
    try { await db.exec(`ALTER TABLE reviews ADD COLUMN ${ddl}`); } catch { /* já existe */ }
  }
  ready = true;
}

// O job considera toda empresa ativa com plano elegível, sem filtrar por período:
// sem limpar, empresas dos testes anteriores entrariam nos números dos seguintes.
async function resetData(db: any) {
  for (const tabela of ['relatorio_envios_mensais', 'reviews', 'usuarios', 'empresas', 'unidades']) {
    try { await db.run(`DELETE FROM ${tabela}`); } catch { /* tabela ausente */ }
  }
}

function novoCnpj(): string {
  return String(Math.floor(10000000000000 + Math.random() * 89999999999999));
}

async function seedEmpresa(db: any, opts: { plan: string; withEmail: boolean }) {
  const empresa = crypto.randomUUID();
  const cnpj = novoCnpj();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO empresas (id, cnpj, nome_empresa, slug, status, plan, criado_em, expira_em)
     VALUES (?, ?, ?, ?, 'ativo', ?, ?, ?)`,
    [empresa, cnpj, 'Empresa Job Teste', `job-${empresa.slice(0, 8)}`, opts.plan, now, now]
  );
  if (opts.withEmail) {
    await db.run(
      `INSERT INTO usuarios (id, cnpj, nome_funcionario, empresa_id, senha_hash, email)
       VALUES (?, ?, 'Dono', ?, 'hash', ?)`,
      [crypto.randomUUID(), cnpj, empresa, `dono-${empresa.slice(0, 8)}@example.com`]
    );
  }
  return empresa;
}

async function seedReview(db: any, empresa: string, mes: string) {
  await db.run(
    `INSERT INTO reviews (empresa_id, name, rating, comment, ai_tags, is_test, createdAt, unidade_id, origin, treated_at)
     VALUES (?, 'Cliente', 5, 'otimo atendimento', ?, 0, ?, NULL, NULL, NULL)`,
    [empresa, JSON.stringify([]), `${mes}-10T12:00:00.000Z`]
  );
}

jobTest('job mensal gera+persiste snapshot e não distribui quando a entrega externa está desligada', async () => {
  await setup();
  const db = getDb();
  await resetData(db);
  const mes = '2026-08';
  const empresa = await seedEmpresa(db, { plan: 'rei', withEmail: true });
  await seedReview(db, empresa, mes);

  const stats = await runMonthlyReportJob(db, mes);
  assert.equal(stats.falhas, 0);
  assert.equal(stats.encaminhados, 0);
  assert.ok(stats.snapshots_gerados >= 1, 'snapshot do período precisa ser gerado');
  assert.ok(stats.distribuicao_desativada >= 1, 'entrega externa desligada não aciona canal algum');

  const row = await db.get(
    'SELECT status, report_json, destinatarios_json FROM relatorio_envios_mensais WHERE empresa_id = ? AND periodo = ?',
    [empresa, mes]
  ) as any;
  assert.equal(row.status, 'generated');
  assert.ok(row.report_json && String(row.report_json).length > 50, 'snapshot persistido para o painel');
  const destinatarios = JSON.parse(String(row.destinatarios_json));
  assert.equal(destinatarios[0]?.destino, `dono-${empresa.slice(0, 8)}@example.com`);

  // Reexecução idempotente: snapshot existente não é regerado nem redistribuído.
  const again = await runMonthlyReportJob(db, mes);
  assert.equal(again.falhas, 0);
  assert.equal(again.snapshots_gerados, 0);
  assert.equal(again.distribuicao_desativada, 0);
  assert.ok(again.pulados >= 1, 'empresa já concluída entra em pulados');
});

jobTest('entrega externa ligada sem n8n: marca distribuição indisponível sem falhar', async () => {
  await setup();
  const db = getDb();
  await resetData(db);
  const mes = '2026-07';
  process.env.MONTHLY_REPORT_EXTERNAL_DELIVERY = '1';
  try {
    const empresa = await seedEmpresa(db, { plan: 'pro', withEmail: true });
    await seedReview(db, empresa, mes);

    const stats = await runMonthlyReportJob(db, mes);
    assert.equal(stats.falhas, 0);
    assert.equal(stats.encaminhados, 0);
    assert.equal(stats.distribuicao_desativada, 0);
    assert.ok(stats.distribuicao_indisponivel >= 1, 'sem n8n configurado a distribuição fica indisponível');

    const row = await db.get('SELECT status, report_json FROM relatorio_envios_mensais WHERE empresa_id = ? AND periodo = ?', [empresa, mes]) as any;
    assert.equal(row.status, 'generated');
    assert.ok(row.report_json, 'snapshot continua persistido mesmo sem distribuição');
  } finally {
    delete process.env.MONTHLY_REPORT_EXTERNAL_DELIVERY;
  }
});

jobTest('empresa sem destinatário configurado e sem usuário com e-mail fica generated/sem_destinatario', async () => {
  await setup();
  const db = getDb();
  await resetData(db);
  const mes = '2026-06';
  const empresa = await seedEmpresa(db, { plan: 'ultra', withEmail: false });
  await seedReview(db, empresa, mes);

  const stats = await runMonthlyReportJob(db, mes);
  assert.equal(stats.falhas, 0);
  assert.ok(stats.sem_destinatario >= 1);
  const row = await db.get('SELECT status, report_json, destinatarios_json FROM relatorio_envios_mensais WHERE empresa_id = ? AND periodo = ?', [empresa, mes]) as any;
  assert.equal(row.status, 'generated');
  assert.ok(row.report_json);
  assert.deepEqual(JSON.parse(String(row.destinatarios_json)), []);
});
