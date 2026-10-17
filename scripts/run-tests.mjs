// Runner de testes independente de shell/globo e da versão do Node.
//
// O runner nativo do Node só expande padrões glob (`tests/**/*.test.ts`) a partir
// do Node 21. No Node 20 (versão usada no CI) o argumento chega literal e o
// runner falha com "Could not find '...tests\**\*.test.ts'". Aqui descobrimos os
// arquivos de teste de forma explícita e determinística e os repassamos como
// caminhos reais para o `node --test`.
//
// Usamos `process.execPath` (o Node que executou este script) com o loader do
// tsx via `--import tsx`, de modo que a suíte rode na MESMA versão de Node em
// qualquer ambiente (Node 20 no CI, Node 26 local), sem depender de um `tsx`
// no PATH que apontaria para outra versão do Node.
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const testsDir = join(root, 'tests');

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const files = collect(testsDir).map((file) => relative(root, file)).sort();
if (files.length === 0) {
  console.error('Nenhum arquivo de teste encontrado em ' + relative(root, testsDir) + '.');
  process.exit(1);
}

console.log('Executando ' + files.length + ' arquivo(s) de teste em ' + process.version + '.\n');

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error('Falha ao iniciar o runner de testes: ' + result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
