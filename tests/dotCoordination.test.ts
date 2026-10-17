/**
 * Coordenação durável entre instâncias (`dot_locks`).
 *
 * O DOT protege a concorrência dentro de um processo com travas em memória;
 * estas travas não valem quando duas instâncias da API rodam contra o mesmo
 * banco. A tabela `dot_locks` dá um claim atômico (INSERT ... ON CONFLICT
 * DO UPDATE ... WHERE expirado) com TTL para recuperação após queda:
 *
 *  - o mesmo lock não é adquirido duas vezes enquanto válido;
 *  - um lock expirado (instância que caiu) é assumido pela próxima chamada;
 *  - `withDotLock` executa o trabalho no máximo uma vez por vez e libera no
 *    final (inclusive em erro).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

let sqliteAvailable = true;
try {
  await import('sqlite3');
  await import('sqlite');
} catch {
  sqliteAvailable = false;
}

const coordinationTest = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !sqliteAvailable }, fn);

import { getDb, initDB } from '../lib/db.js';
import { acquireDotLock, releaseDotLock, withDotLock } from '../services/dotCoordination.js';

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = '/tmp/filtra-dot-coordination-test.sqlite';

let ready = false;

async function setup() {
  if (ready) return;
  await initDB();
  ready = true;
}

async function reset() {
  await setup();
  const db = getDb();
  try {
    await db.run('DELETE FROM dot_locks');
  } catch {
    /* tabela criada sob demanda pelo primeiro acquire */
  }
}

coordinationTest('lock: segunda aquisição falha enquanto a primeira está válida', async () => {
  await setup();
  await reset();
  const name = 'teste:basico';

  const ownerA = await acquireDotLock(name, 60_000);
  assert.ok(ownerA, 'a primeira aquisição deve vencer');
  const ownerB = await acquireDotLock(name, 60_000);
  assert.equal(ownerB, null, 'a segunda aquisição não pode vencer com o lock válido');

  await releaseDotLock(name, ownerA!);
  const ownerC = await acquireDotLock(name, 60_000);
  assert.ok(ownerC, 'após liberar, a próxima aquisição deve vencer');
  await releaseDotLock(name, ownerC!);
});

coordinationTest('lock: liberação escopada não remove o lock de outro dono', async () => {
  await setup();
  await reset();
  const name = 'teste:dono';

  const ownerA = await acquireDotLock(name, 60_000);
  assert.ok(ownerA);
  await releaseDotLock(name, 'outro-dono-qualquer');
  const ownerB = await acquireDotLock(name, 60_000);
  assert.equal(ownerB, null, 'o lock do dono A continua válido');
  await releaseDotLock(name, ownerA!);
});

coordinationTest('lock: lock expirado é assumido pela próxima chamada (recuperação após queda)', async () => {
  await setup();
  await reset();
  const name = 'teste:expirado';

  const ownerA = await acquireDotLock(name, 60_000);
  assert.ok(ownerA);
  // Simula a queda da instância: o prazo passa sem liberação.
  await getDb().run('UPDATE dot_locks SET expires_at = ? WHERE name = ?', [
    new Date(Date.now() - 60_000).toISOString(),
    name,
  ]);

  const ownerB = await acquireDotLock(name, 60_000);
  assert.ok(ownerB, 'a instância seguinte assume o lock expirado');
  assert.notEqual(ownerB, ownerA, 'o novo dono é outra execução');
  await releaseDotLock(name, ownerB!);
});

coordinationTest('withDotLock: pula quando ocupado e executa quando livre', async () => {
  await setup();
  await reset();
  const name = 'teste:compose';

  const owner = await acquireDotLock(name, 60_000);
  assert.ok(owner);

  let ranWhileBusy = false;
  const busy = await withDotLock(name, 60_000, async () => {
    ranWhileBusy = true;
    return 'nunca';
  });
  assert.equal(busy.acquired, false);
  assert.equal(ranWhileBusy, false, 'o trabalho não roda com o lock ocupado');

  await releaseDotLock(name, owner!);
  const free = await withDotLock(name, 60_000, async () => 'ok');
  assert.equal(free.acquired, true);
  assert.equal(free.acquired && free.result, 'ok');
});

coordinationTest('withDotLock: espera o lock e nunca sobrepõe execuções', async () => {
  await setup();
  await reset();
  const name = 'teste:espera';

  let active = 0;
  let maxActive = 0;
  let executions = 0;
  const work = async () => {
    executions += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 120));
    active -= 1;
    return executions;
  };

  const [first, second] = await Promise.all([
    withDotLock(name, 60_000, work, { waitMs: 5_000, pollMs: 50 }),
    withDotLock(name, 60_000, work, { waitMs: 5_000, pollMs: 50 }),
  ]);

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, true);
  assert.equal(executions, 2, 'as duas chamadas executam, uma depois da outra');
  assert.equal(maxActive, 1, 'nunca há duas execuções simultâneas do mesmo lock');
});

coordinationTest('withDotLock: libera o lock mesmo quando o trabalho lança erro', async () => {
  await setup();
  await reset();
  const name = 'teste:erro';

  await assert.rejects(
    withDotLock(name, 60_000, async () => {
      throw new Error('falha simulada');
    }),
    /falha simulada/,
  );

  const owner = await acquireDotLock(name, 60_000);
  assert.ok(owner, 'o lock precisa estar livre após o erro');
  await releaseDotLock(name, owner!);
});
