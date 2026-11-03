/**
 * Garante que o runner de testes é multiplataforma: não usa `find`/`xargs`
 * (indisponíveis no PowerShell) e mantém a separação padrão/PostgreSQL.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(backendRoot, 'scripts', 'run-tests.mjs');

function list(args: string[]): string[] {
  const result = spawnSync(process.execPath, [runner, '--list', ...args], {
    cwd: backendRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `runner falhou: ${result.stderr}`);
  return JSON.parse(result.stdout) as string[];
}

test('runner padrão lista testes comuns e exclui *.pg.test.ts', () => {
  const files = list([]);
  assert.ok(files.length > 0, 'a suíte padrão não pode ficar vazia');
  assert.equal(files.some((file) => file.endsWith('.pg.test.ts')), false);
  assert.ok(files.some((file) => file.endsWith('dbMigrationsGuards.test.ts')));
  for (const file of files) {
    assert.ok(fs.existsSync(path.resolve(backendRoot, file)), `arquivo deve existir: ${file}`);
  }
});

test('runner --postgres lista somente *.pg.test.ts', () => {
  const files = list(['--postgres']);
  assert.ok(files.length > 0);
  assert.ok(files.every((file) => file.endsWith('.pg.test.ts')));
  assert.ok(files.some((file) => file.endsWith('dbInitializationConcurrency.pg.test.ts')));
});

test('scripts de teste não dependem de find/xargs (Windows/PowerShell)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(backendRoot, 'package.json'), 'utf8'));
  for (const script of ['test', 'test:postgres']) {
    const command = String(pkg.scripts[script] || '');
    assert.equal(/\bfind\b/.test(command), false, `${script} não pode usar find`);
    assert.equal(/\bxargs\b/.test(command), false, `${script} não pode usar xargs`);
    assert.match(command, /node\s+scripts\/run-tests\.mjs/);
  }
  const runnerSource = fs.readFileSync(runner, 'utf8');
  assert.equal(/spawnSync\('find'|\bxargs\b/.test(runnerSource), false);
});
