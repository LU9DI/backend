/**
 * Validação de migrations em banco descartável/staging (nunca produção).
 *
 * Uso:
 *   FILTRA_STAGING_CONFIRM=1 \
 *   DATABASE_URL=postgresql://usuario:senha@host:5432/banco_staging \
 *   PG_BIN="C:/Program Files/PostgreSQL/17/bin" \
 *   npx tsx scripts/staging-migration-check.ts [--backup-restore] [--failure-test]
 *
 * O script:
 *  1. recusa hosts de produção conhecidos;
 *  2. aplica as migrações centrais (initDB) e as reaplica (idempotência);
 *  3. compara a impressão digital do schema entre as duas aplicações;
 *  4. valida tabelas, índices e a unicidade de (empresa_id, idempotency_key);
 *  5. opcionalmente ensaia backup/restauração (pg_dump/pg_restore);
 *  6. opcionalmente injeta falha durante a migração e verifica a retomada.
 *
 * Não imprime a URL completa (credenciais), apenas host/banco.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { initDB, closeDB } from '../lib/db.js';
import { runCentralMigrations } from '../lib/migrations.js';

type Fingerprint = {
  columns: string;
  indexes: string;
  constraints: string;
  digest: string;
};

const PRODUCTION_HOST_PATTERNS = [
  /\.onrender\.com$/i,
  /\.supabase\.co$/i,
  /\.neon\.tech$/i,
  /(^|\.)filtraai\.com$/i,
];

const REQUIRED_TABLES = [
  'empresas',
  'reviews',
  'usuarios',
  'ai_usage',
  'dot_budget_reservations',
  'dot_http_idempotency',
  'dot_action_queue',
  'dot_action_audit',
];

const REQUIRED_INDEXES: Array<{ name: string; unique?: boolean }> = [
  { name: 'ux_dot_http_idempotency_empresa_key', unique: true },
  { name: 'idx_dot_http_idempotency_tenant_status' },
  { name: 'idx_dot_http_idempotency_expiry' },
  { name: 'idx_dot_budget_reservations_empresa' },
  { name: 'idx_dot_budget_reservations_exec' },
  { name: 'ux_dot_budget_reservations_ai_usage', unique: true },
  { name: 'idx_ai_usage_feature' },
];

function fail(message: string): never {
  console.error(`FALHA: ${message}`);
  process.exit(1);
}

function targetUrl(): URL {
  const raw = (process.env.DATABASE_URL || '').trim();
  if (!raw) fail('DATABASE_URL é obrigatória.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail('DATABASE_URL inválida.');
  }
  if (!/^postgres(ql)?:$/i.test(url.protocol)) fail('DATABASE_URL deve ser postgres:// ou postgresql://.');
  if (process.env.FILTRA_STAGING_CONFIRM !== '1') {
    fail('Defina FILTRA_STAGING_CONFIRM=1 para confirmar que o alvo NÃO é produção.');
  }
  const host = url.hostname.toLowerCase();
  if (PRODUCTION_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    fail(
      `host ${host} corresponde a um provedor de produção conhecido. ` +
        'Este script é exclusivo para banco descartável/staging.',
    );
  }
  return url;
}

function maskUrl(url: URL): string {
  return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
}

function pgBin(name: string): string {
  const dir = (process.env.PG_BIN || '').trim();
  return dir ? path.join(dir, `${name}.exe`) : name;
}

async function queryJson(client: Client, sql: string): Promise<unknown[]> {
  const result = await client.query(sql);
  return result.rows;
}

async function fingerprint(client: Client): Promise<Fingerprint> {
  const columns = await queryJson(
    client,
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, column_name`,
  );
  const indexes = await queryJson(
    client,
    `SELECT tablename, indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname`,
  );
  const constraints = await queryJson(
    client,
    `SELECT conrelid::regclass::text AS table_name, conname, contype, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace
      ORDER BY 1, 2`,
  );
  const payload = JSON.stringify({ columns, indexes, constraints });
  return {
    columns: crypto.createHash('sha256').update(JSON.stringify(columns)).digest('hex'),
    indexes: crypto.createHash('sha256').update(JSON.stringify(indexes)).digest('hex'),
    constraints: crypto.createHash('sha256').update(JSON.stringify(constraints)).digest('hex'),
    digest: crypto.createHash('sha256').update(payload).digest('hex'),
  };
}

async function validateObjects(client: Client): Promise<void> {
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const present = new Set(tables.rows.map((row) => row.table_name));
  const missingTables = REQUIRED_TABLES.filter((table) => !present.has(table));
  if (missingTables.length) fail(`tabelas ausentes: ${missingTables.join(', ')}`);

  for (const required of REQUIRED_INDEXES) {
    const result = await client.query<{ indisunique: boolean }>(
      `SELECT i.indisunique
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = $1`,
      [required.name],
    );
    if (result.rowCount === 0) fail(`índice ausente: ${required.name}`);
    if (required.unique && !result.rows[0].indisunique) {
      fail(`índice ${required.name} deveria ser UNIQUE.`);
    }
  }

  // Unicidade de tenant+chave realmente imposta pelo banco (não só pelo código).
  await client.query('BEGIN');
  try {
    const insert = `INSERT INTO dot_http_idempotency
      (empresa_id, endpoint, idempotency_key, request_hash, status, created_at, updated_at, expires_at)
      VALUES ($1, $2, $3, $4, 'processing', now()::text, now()::text, now()::text)`;
    await client.query(insert, ['staging-check', '/api/dot/chat', 'chave-staging-1', 'hash-a']);
    let duplicated = false;
    try {
      await client.query(insert, ['staging-check', '/api/dot/chat', 'chave-staging-1', 'hash-b']);
    } catch (error: any) {
      duplicated = error?.code === '23505' || /duplicate key/i.test(String(error?.message));
    }
    if (!duplicated) fail('o banco aceitou chave de idempotência duplicada para o mesmo tenant.');
  } finally {
    await client.query('ROLLBACK');
  }
}

async function applyMigrations(label: string): Promise<Fingerprint> {
  await initDB();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const fp = await fingerprint(client);
    console.log(`${label}: schema aplicado (${fp.digest.slice(0, 16)}…)`);
    return fp;
  } finally {
    await client.end();
    await closeDB();
  }
}

function assertEqualDigest(first: Fingerprint, second: Fingerprint, label: string) {
  if (first.digest !== second.digest) {
    fail(
      `${label}: schema divergiu entre aplicações ` +
        `(columns ${first.columns.slice(0, 8)}→${second.columns.slice(0, 8)}, ` +
        `indexes ${first.indexes.slice(0, 8)}→${second.indexes.slice(0, 8)}, ` +
        `constraints ${first.constraints.slice(0, 8)}→${second.constraints.slice(0, 8)})`,
    );
  }
}

async function backupRestoreCheck(url: URL, original: Fingerprint) {
  const database = url.pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+$/i.test(database)) fail('nome do banco precisa ser simples para o ensaio de backup.');
  const restoreName = `${database}_restore`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'filtra-staging-'));
  const dumpFile = path.join(tmp, `${database}.dump`);
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${restoreName}"`);
    await admin.query(`CREATE DATABASE "${restoreName}"`);
  } finally {
    await admin.end();
  }
  try {
    execFileSync(pgBin('pg_dump'), ['--no-owner', '--no-privileges', '-Fc', '-f', dumpFile, url.toString()], {
      stdio: 'inherit',
    });
    const restoreUrl = new URL(url.toString());
    restoreUrl.pathname = `/${restoreName}`;
    execFileSync(pgBin('pg_restore'), ['--no-owner', '--no-privileges', '-d', restoreUrl.toString(), dumpFile], {
      stdio: 'inherit',
    });
    const restored = new Client({ connectionString: restoreUrl.toString() });
    await restored.connect();
    try {
      const restoredFp = await fingerprint(restored);
      assertEqualDigest(original, restoredFp, 'backup/restore');
      console.log(`backup/restore: schema restaurado idêntico (${restoredFp.digest.slice(0, 16)}…)`);
    } finally {
      await restored.end();
    }
  } finally {
    const cleanup = new Client({ connectionString: url.toString() });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${restoreName}"`);
    } finally {
      await cleanup.end();
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function failureRecoveryCheck(url: URL) {
  const database = url.pathname.replace(/^\//, '');
  const failureName = `${database}_failure`;
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${failureName}"`);
    await admin.query(`CREATE DATABASE "${failureName}"`);
  } finally {
    await admin.end();
  }

  const failureUrl = new URL(url.toString());
  failureUrl.pathname = `/${failureName}`;
  const previous = process.env.DATABASE_URL;

  try {
    const setup = new Client({ connectionString: failureUrl.toString() });
    await setup.connect();
    // Objeto incompatível: força a migração a falhar depois de já ter criado
    // tabelas, simulando interrupção no meio do processo.
    await setup.query('CREATE VIEW reviews AS SELECT 1 AS x');
    await setup.end();

    process.env.DATABASE_URL = failureUrl.toString();
    let failed = false;
    try {
      await initDB();
    } catch (error: any) {
      failed = true;
      await closeDB();
      console.log(`falha injetada: migração interrompida (${String(error?.message || error).slice(0, 160)})`);
    }
    if (!failed) fail('a falha injetada não interrompeu a migração.');

    const cleanup = new Client({ connectionString: failureUrl.toString() });
    await cleanup.connect();
    await cleanup.query('DROP VIEW reviews');
    await cleanup.end();

    await initDB();
    const client = new Client({ connectionString: failureUrl.toString() });
    await client.connect();
    try {
      const fp = await fingerprint(client);
      await validateObjects(client);
      console.log(`retomada após falha: schema íntegro (${fp.digest.slice(0, 16)}…)`);
    } finally {
      await client.end();
      await closeDB();
    }
  } finally {
    process.env.DATABASE_URL = previous;
    const cleanup = new Client({ connectionString: url.toString() });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${failureName}"`);
    } finally {
      await cleanup.end();
    }
  }
}

async function main() {
  const url = targetUrl();
  console.log(`alvo: ${maskUrl(url)} (confirmado como NÃO produção)`);
  const args = new Set(process.argv.slice(2));

  const first = await applyMigrations('aplicação 1/2');
  const second = await applyMigrations('aplicação 2/2 (idempotência)');
  assertEqualDigest(first, second, 'repetição de migrations');

  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await validateObjects(client);
    console.log('objetos obrigatórios, índices e unicidade por tenant: OK');
    if (args.has('--backup-restore')) await backupRestoreCheck(url, first);
  } finally {
    await client.end();
  }

  if (args.has('--failure-test')) await failureRecoveryCheck(url);

  console.log(JSON.stringify({ ok: true, target: maskUrl(url), digest: first }, null, 2));
}

main().catch(async (error) => {
  console.error('FALHA:', error?.message || error);
  try {
    await closeDB();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
