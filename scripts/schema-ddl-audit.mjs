#!/usr/bin/env node
/**
 * Auditoria de DDL fora de `lib/migrations.ts`.
 *
 * Lista toda ocorrência de ALTER TABLE / CREATE TABLE / CREATE INDEX no código
 * de aplicação (lib, services, routes, middleware e arquivos raiz). Usada pelo
 * teste `tests/schemaDdlAudit.test.ts` para garantir que `reviews` não tem mais
 * DDL em caminhos de requisição.
 *
 * Uso: node scripts/schema-ddl-audit.mjs [--json]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, '..');
const SCAN_DIRS = ['lib', 'services', 'routes', 'middleware'];
const SKIP = new Set(['node_modules', 'tests', 'scripts', 'dist', 'data']);
const DDL = /\b(ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX))\b/gi;

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile() && full.endsWith('.ts')) files.push(full);
  }
  return files;
}

function relative(file) {
  return path.relative(backendRoot, file).split(path.sep).join('/');
}

export function collectSchemaDdl(root = backendRoot) {
  const files = [];
  for (const dir of SCAN_DIRS) files.push(...walk(path.join(root, dir)));
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path.join(root, entry.name));
  }

  const occurrences = [];
  for (const file of files.sort()) {
    if (relative(file) === 'lib/migrations.ts') continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const match of line.matchAll(DDL)) {
        occurrences.push({
          file: relative(file),
          line: index + 1,
          statement: match[0].replace(/\s+/g, ' ').toUpperCase(),
          excerpt: line.trim().slice(0, 200),
        });
      }
    });
  }
  return occurrences;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const json = process.argv.includes('--json');
  const occurrences = collectSchemaDdl();
  if (json) {
    process.stdout.write(`${JSON.stringify(occurrences, null, 2)}\n`);
  } else {
    for (const item of occurrences) console.log(`${item.file}:${item.line}  ${item.statement}`);
    console.log(`\n${occurrences.length} ocorrência(s) fora de lib/migrations.ts`);
  }
}
