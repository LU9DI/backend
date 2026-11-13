/**
 * Regressão de deadlock: as migrações rodam NA conexão dedicada que mantém o
 * advisory lock, então `PG_POOL_MAX=1` é suficiente. Se a implementação
 * tentasse pegar uma segunda conexão do pool, este teste travaria.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initPgDatabase } from '../lib/db.pg.js';
import { runCentralMigrations } from '../lib/migrations.js';
import { createTestDatabase, dropTestDatabase } from './helpers/pg-test-utils.js';

// O objetivo deste teste é detectar DEADLOCK (espera infinita), não impor um
// orçamento de performance. Em hosts lentos a primeira migração (DDL + índices)
// pode passar de 20s legitimamente; 60s por execução ainda falha em deadlock
// real sem flakar por lentidão de I/O.
const MIGRATION_TIMEOUT_MS = 60_000;

test('PG_POOL_MAX=1 conclui migrações sem deadlock e libera a conexão', async () => {
  const previousMax = process.env.PG_POOL_MAX;
  process.env.PG_POOL_MAX = '1';
  const created = await createTestDatabase('pg_pool_one');
  const db = await initPgDatabase(created.url);
  try {
    // Cada execução tem seu próprio prazo: o timer não deve acumular o tempo
    // das duas migrações (a segunda é idempotente e rápida).
    const withDeadline = async <T>(work: Promise<T>): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      const deadlock = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`deadlock: migrações não terminaram em ${MIGRATION_TIMEOUT_MS}ms com PG_POOL_MAX=1`)),
          MIGRATION_TIMEOUT_MS,
        );
      });
      try {
        return await Promise.race([work, deadlock]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    await withDeadline(runCentralMigrations(db));
    await withDeadline(runCentralMigrations(db)); // idempotente, ainda com 1 conexão

    const columns = await db.all(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name='reviews'`);
    const names = columns.map((row: any) => String(row.name).toLowerCase());
    assert.ok(names.includes('createdat'), 'coluna canônica deve existir após migração');

    // Pool continua utilizável depois que o lock devolve a única conexão.
    const ok = await db.get<{ ok: number }>('SELECT 1 AS ok');
    assert.equal(ok?.ok, 1);

    // Nenhuma conexão extra foi necessária: só a do próprio teste permanece.
    const others = await db.get<{ c: number }>(
      `SELECT count(*)::int AS c FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    assert.equal(Number(others?.c), 0, 'migração não pode abrir conexões extras além da conexão do lock');
  } finally {
    await db.close();
    if (previousMax === undefined) delete process.env.PG_POOL_MAX;
    else process.env.PG_POOL_MAX = previousMax;
    await dropTestDatabase(created.name);
  }
});
