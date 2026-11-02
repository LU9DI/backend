import { initDB, closeDB } from '../../lib/db.js';
import { approveDotAction } from '../../services/dotActionQueue.js';

const [empresaId, actionIdText, actorUserId] = process.argv.slice(2);
if (!empresaId || !actionIdText || !actorUserId) throw new Error('Argumentos insuficientes para o worker de aprovação PostgreSQL.');
process.env.NODE_ENV = 'test';
console.log = (...args: unknown[]) => console.error(...args);
await initDB();
try {
  const result = await approveDotAction(empresaId, Number(actionIdText), actorUserId);
  process.stdout.write(JSON.stringify(result));
} finally {
  await closeDB();
}
