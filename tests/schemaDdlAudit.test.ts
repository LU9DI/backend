/**
 * Auditoria automatizada: nenhuma DDL de `reviews` pode existir fora de
 * lib/migrations.ts. DDL de outras tabelas é permitida, mas precisa aparecer
 * na auditoria para ser justificada no relatório do PR.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(backendRoot, 'scripts', 'schema-ddl-audit.mjs');

type Occurrence = { file: string; line: number; statement: string; excerpt: string };

function audit(): Occurrence[] {
  const result = spawnSync(process.execPath, [script, '--json'], { cwd: backendRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Occurrence[];
}

test('nenhuma DDL de reviews fora de lib/migrations.ts', () => {
  const occurrences = audit();
  assert.ok(occurrences.length > 0, 'a auditoria deve encontrar DDL de outras tabelas');
  assert.equal(occurrences.some((item) => item.file === 'lib/migrations.ts'), false);
  const reviews = occurrences.filter((item) => /\breviews\b/i.test(item.excerpt));
  assert.deepEqual(reviews, [], `DDL de reviews encontrada fora da migração central: ${JSON.stringify(reviews)}`);
});

test('auditoria cobre os módulos com DDL remanescente para justificativa', () => {
  const files = new Set(audit().map((item) => item.file));
  for (const expected of ['lib/planPricing.ts', 'lib/auditLog.ts', 'routes/pixRoutes.ts', 'services/trialService.ts']) {
    assert.ok(files.has(expected), `${expected} deveria aparecer na auditoria de DDL`);
  }
});
