/**
 * Utilitários compartilhados pelos testes PostgreSQL reais (*.pg.test.ts).
 * Nunca fazem parte de `npm test`: exigem DATABASE_URL apontando para um
 * PostgreSQL descartável e criam/derrubam bancos temporários.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

export type WorkerResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
};

/** Erros de DDL/corrida que jamais podem aparecer em stderr. */
export const DDL_ERROR_PATTERNS: RegExp[] = [
  /already exists/i,
  /\b42P07\b/,
  /\b42701\b/,
  /\b23505\b/,
  /duplicate column/i,
  /duplicate key value violates unique constraint/i,
  /pg\.exec falhou/i,
  /pg\.transaction: ROLLBACK falhou/i,
  /advisory lock/i,
];

/** Hosts locais permitidos por padrão para testes PostgreSQL reais. */
const LOCAL_TEST_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Guarda OBRIGATÓRIA: o teste PostgreSQL cria/derruba bancos no servidor
 * indicado por DATABASE_URL. Sem esta trava, apontar DATABASE_URL para um
 * servidor real executaria `CREATE DATABASE`/`DROP DATABASE` em produção.
 *
 * Regras:
 *  - hosts locais (localhost/127.0.0.1/::1) são permitidos;
 *  - qualquer outro host só entra se estiver listado (separado por vírgula)
 *    em `FILTERA_PG_TEST_ALLOWED_HOSTS`;
 *  - nunca confie na presença de "test" no nome do host/banco — não é prova
 *    de isolamento.
 */
export function assertSafeTestDatabaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL de teste PostgreSQL inválida (não é uma URL válida).');
  }
  if (!/^postgres(ql)?:$/i.test(parsed.protocol)) {
    throw new Error('DATABASE_URL de teste PostgreSQL deve ser uma URL postgres:// ou postgresql://.');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const allowed = (process.env.FILTERA_PG_TEST_ALLOWED_HOSTS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (!LOCAL_TEST_HOSTS.has(host) && !allowed.includes(host)) {
    throw new Error(
      `DATABASE_URL de teste PostgreSQL recusada: host "${host}" não é localhost ` +
        `nem está em FILTERA_PG_TEST_ALLOWED_HOSTS. Testes PostgreSQL jamais rodam contra produção.`,
    );
  }
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  assert.ok(url, 'DATABASE_URL de teste PostgreSQL é obrigatória para testes *.pg.test.ts');
  assertSafeTestDatabaseUrl(url);
  return url;
}

function postgresAdminUrl(): string {
  const url = new URL(databaseUrl());
  url.pathname = '/postgres';
  return url.toString();
}

export async function withAdminClient<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: postgresAdminUrl() });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function createTestDatabase(prefix: string): Promise<{ name: string; url: string }> {
  const name = `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`.toLowerCase();
  await withAdminClient(async (client) => {
    await client.query(`CREATE DATABASE "${name}"`);
  });
  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

export async function dropTestDatabase(name: string): Promise<void> {
  await withAdminClient(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });
}

export async function serverVersion(): Promise<string> {
  return withAdminClient(async (client) => {
    const result = await client.query('SHOW server_version');
    return String(result.rows[0].server_version);
  });
}

/**
 * Executa um script Node/TS em processo filho, preservando stdout/stderr
 * separados para inspeção (não basta olhar o exit code).
 */
export function runNodeScript(
  scriptUrl: URL,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
  timeoutMs = 0,
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(scriptUrl), ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: 'test', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs)
      : undefined;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, signal, timedOut });
    });
  });
}

export function assertNoDdlErrors(stderr: string, label: string): void {
  for (const pattern of DDL_ERROR_PATTERNS) {
    assert.ok(
      !pattern.test(stderr),
      `${label}: stderr contém erro de DDL/corrida (${pattern}):\n${stderr}`,
    );
  }
}

export function parseWorkerJson<T>(result: WorkerResult, label: string): T {
  assert.equal(result.code, 0, `${label}: processo terminou com código ${result.code} (sinal ${result.signal})\nstderr:\n${result.stderr}`);
  assertNoDdlErrors(result.stderr, label);
  // O processo pode emitir logs estruturados (uma linha JSON por evento) antes
  // do resultado. O contrato é: o resultado é o ÚLTIMO JSON completo impresso —
  // inclusive escalares como `null` (a instância que perde a corrida devolve
  // `null`), por isso a busca aceita qualquer JSON válido, não só objetos.
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]) as T;
    } catch {
      /* linha de log truncada ou JSON parcial: tenta a anterior */
    }
  }
  throw new Error(`${label}: stdout não contém JSON válido:\n${result.stdout}\nstderr:\n${result.stderr}`);
}
