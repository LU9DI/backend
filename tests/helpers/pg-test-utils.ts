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

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  assert.ok(url, 'DATABASE_URL de teste PostgreSQL é obrigatória para testes *.pg.test.ts');
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
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(`${label}: stdout não é JSON (${String(error)}):\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}
