import { initDB, closeDB } from '../../lib/db.js';
import { prepareDotActionFromDecision } from '../../services/dotActionQueue.js';

const [empresaId, decisionIdText, optionId] = process.argv.slice(2);
if (!empresaId || !decisionIdText || !optionId) throw new Error('Argumentos insuficientes para o worker PostgreSQL.');
process.env.NODE_ENV = 'test';
console.log = (...args: unknown[]) => console.error(...args);
await initDB();
try {
  const result = await prepareDotActionFromDecision(empresaId, Number(decisionIdText), optionId, 'pg-concurrency-worker');
  if (!result?.id) throw new Error('A preparação concorrente não retornou uma ação.');
  process.stdout.write(JSON.stringify({ id: result.id, status: result.status }));
} finally {
  await closeDB();
}
