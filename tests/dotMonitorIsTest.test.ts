/**
 * A2 — `reviews.is_test` como campo legítimo do contrato e migração idempotente.
 *
 * Cenários:
 *  - banco novo: a coluna nasce com o schema base e o monitor roda sem
 *    "no such column: is_test";
 *  - banco existente (schema antigo, sem a coluna): o initDB adiciona a coluna
 *    de forma idempotente, sem inferir valores históricos (default 0);
 *  - erro por empresa no scheduler fica observável (resultado + status) sem
 *    derrubar a rodada e sem vazar conteúdo de avaliação.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';

let sqliteAvailable = true;
try {
  await import('sqlite3');
  await import('sqlite');
} catch {
  sqliteAvailable = false;
}

const isTestTest = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !sqliteAvailable }, fn);

process.env.NODE_ENV = 'test';

const freshDbPath = '/tmp/filtra-dot-is-test-fresh.sqlite';
const legacyDbPath = '/tmp/filtra-dot-is-test-legacy.sqlite';
const schedulerDbPath = '/tmp/filtra-dot-is-test-scheduler.sqlite';

function removeDb(path: string) {
  try {
    fs.unlinkSync(path);
  } catch {
    /* banco ainda não existe */
  }
}

async function createLegacyDatabase(path: string) {
  const sqlite3 = (await import('sqlite3')).default;
  const { open } = await import('sqlite');
  const db = await open({ filename: path, driver: sqlite3.Database });
  // Schema anterior à migração: reviews SEM is_test.
  await db.exec(`CREATE TABLE reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id TEXT,
    name TEXT,
    rating INTEGER,
    comment TEXT,
    ai_reply TEXT,
    ai_tags TEXT,
    createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.run(
    'INSERT INTO reviews (empresa_id,name,rating,comment,ai_tags) VALUES (?,?,?,?,?)',
    ['empresa-legada', 'Cliente', 2, 'Demora no atendimento', JSON.stringify(['tempo de espera'])],
  );
  await db.close();
}

async function seedEmpresa(empresaId: string, plan = 'rei') {
  const { getDb } = await import('../lib/db.js');
  const now = new Date().toISOString();
  await getDb().run(
    'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
    [empresaId, 'cnpj-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14), 'Empresa ' + empresaId.slice(0, 6), 'slug-' + empresaId.slice(0, 8), 'ativo', plan, now, now],
  );
}

isTestTest('A2: init limpo cria is_test e o monitor roda sem erro de coluna', async () => {
  removeDb(freshDbPath);
  process.env.SQLITE_DB_PATH = freshDbPath;
  const { initDB, getDb } = await import('../lib/db.js');
  await initDB();

  const columns = await getDb().all('PRAGMA table_info(reviews)');
  assert.ok(
    (columns || []).some((column: { name?: string }) => column.name === 'is_test'),
    'is_test deve existir no schema base do banco novo',
  );

  const empresa = crypto.randomUUID();
  await seedEmpresa(empresa);
  await getDb().run(
    'INSERT INTO reviews (empresa_id,name,rating,comment,ai_tags,is_test,createdAt) VALUES (?,?,?,?,?,0,?)',
    [empresa, 'Cliente', 2, 'Demora no atendimento', JSON.stringify(['tempo de espera']), new Date().toISOString()],
  );

  const { runDotMonitor } = await import('../services/dotMonitor.js');
  const result = await runDotMonitor(empresa);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
});

isTestTest('A2: banco legado sem is_test ganha a coluna por migração idempotente', async () => {
  removeDb(legacyDbPath);
  await createLegacyDatabase(legacyDbPath);
  process.env.SQLITE_DB_PATH = legacyDbPath;
  const { initDB, getDb } = await import('../lib/db.js');
  await initDB();

  let columns = await getDb().all('PRAGMA table_info(reviews)');
  assert.ok((columns || []).some((column: { name?: string }) => column.name === 'is_test'), 'a migração deve adicionar is_test');

  // Regra documentada: avaliações anteriores à migração não são de teste.
  const rows = await getDb().all('SELECT is_test FROM reviews');
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].is_test), 0);

  // Idempotência: rodar o initDB de novo não falha nem duplica a coluna.
  await initDB();
  columns = await getDb().all('PRAGMA table_info(reviews)');
  assert.equal(columns.filter((column: { name?: string }) => column.name === 'is_test').length, 1);

  // E o monitor usa a coluna migrada sem erro.
  const { runDotMonitor } = await import('../services/dotMonitor.js');
  const result = await runDotMonitor('empresa-legada');
  assert.equal(result.ok, true);
});

isTestTest('A2: erro por empresa no scheduler fica observável sem derrubar a rodada', async () => {
  removeDb(schedulerDbPath);
  process.env.SQLITE_DB_PATH = schedulerDbPath;
  const { initDB, getDb } = await import('../lib/db.js');
  await initDB();

  const empresa = crypto.randomUUID();
  await seedEmpresa(empresa);

  const { runDueDotMonitors, getDotSchedulerStatus } = await import('../services/dotScheduler.js');

  // Simula o estado que o banco antigo produzia: a coluna não existe.
  await getDb().exec('ALTER TABLE reviews RENAME TO reviews_sem_is_test');
  try {
    const run = await runDueDotMonitors();
    assert.equal(run.ok, true, 'a rodada não pode falhar por completo');
    const failed = (run.results || []).find((item: any) => item.empresa_id === empresa);
    assert.ok(failed, 'a empresa com falha deve aparecer no resultado da rodada');
    assert.equal(failed.ok, false);
    assert.match(String(failed.error), /no such table|no such column/i);

    const status = getDotSchedulerStatus();
    assert.ok(status.companies_errors >= 1, 'o status do scheduler deve registrar o erro por empresa');
    assert.ok(String(status.last_error || '').length > 0);
  } finally {
    await getDb().exec('ALTER TABLE reviews_sem_is_test RENAME TO reviews');
  }

  // O log de erro não carrega conteúdo de avaliação nem segredo.
  const logs: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) =>
    logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  try {
    await getDb().exec('ALTER TABLE reviews RENAME TO reviews_sem_is_test');
    await runDueDotMonitors();
    await getDb().exec('ALTER TABLE reviews_sem_is_test RENAME TO reviews');
  } finally {
    console.warn = originalWarn;
  }
  const failureLogs = logs.filter((line) => line.includes('[dot-scheduler] empresa falhou'));
  assert.ok(failureLogs.length >= 1, 'a falha por empresa precisa ser registrada em log');
  assert.ok(failureLogs.some((line) => line.includes(empresa)), 'o log deve identificar a empresa');
  assert.ok(!failureLogs.some((line) => line.includes('Demora no atendimento')), 'o log não pode conter conteúdo de avaliação');
});
