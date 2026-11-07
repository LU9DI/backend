/**
 * Worker de finalização do ledger em processo separado (pool próprio).
 *
 * Usado por `tests/dotLedger.pg.test.ts` para provar concorrência REAL entre
 * instâncias no PostgreSQL — não apenas dentro do mesmo event loop.
 */
import { initDB, getDb, closeDB } from '../../lib/db.js';
import { ensureDotLedgerSchema, finalizeDotReservation, reserveDotExecution } from '../../services/dotLedger.js';

// CONTRATO DE SAÍDA: stdout carrega SOMENTE o JSON final; qualquer log da
// aplicação (ex.: `initDB` → "Postgres conectado"/"Schema inicializado") é
// redirecionado para stderr. Sem isso, `parseWorkerJson` (que faz
// `JSON.parse(stdout)`) falha com "stdout não é JSON".
process.env.NODE_ENV = 'test';
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);

async function main() {
  const [mode, empresaId, rawId, rawTokens] = process.argv.slice(2);
  await initDB();
  await ensureDotLedgerSchema();
  const tokens = Number(rawTokens || 0) || 0;

  if (mode === 'reserve') {
    const result = await reserveDotExecution({ empresaId, plan: 'rei' });
    const payload = {
      ok: result.ok,
      code: result.code ?? null,
      id: result.reservation?.id ?? null,
      response_limit: result.snapshot.response_limit,
      reserved: result.snapshot.reserved,
      remaining: result.snapshot.remaining,
    };
    await closeDB();
    process.stdout.write(JSON.stringify(payload));
    return;
  }

  const result = await finalizeDotReservation({
    empresaId,
    reservationId: Number(rawId),
    tokens,
    provider: 'groq',
    tipo: 'filtra_dot_chat',
  });
  const db = getDb();
  const usage = await db.get(
    'SELECT COALESCE(SUM(tokens),0) AS t, COUNT(*) AS c FROM ai_usage WHERE empresa_id = ? AND feature = ?',
    [empresaId, 'dot'],
  );
  const payload = {
    ok: result.ok,
    duplicate: Boolean(result.duplicate),
    status: result.reservation?.status ?? null,
    ai_usage_rows: Number(usage?.c || 0),
    ai_usage_tokens: Number(usage?.t || 0),
  };
  await closeDB();
  process.stdout.write(JSON.stringify(payload));
}

main().catch((error) => {
  process.stderr.write(String(error?.stack || error));
  process.exit(1);
});
