/**
 * Snapshot real de índices (pg_indexes): nome, tabela e definição.
 * Deve detectar índice ausente e definição alterada (inclusive único/parcial).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initPgDatabase } from '../lib/db.pg.js';
import { listIndexDefinitions, runCentralMigrations } from '../lib/migrations.js';
import { createTestDatabase, dropTestDatabase } from './helpers/pg-test-utils.js';

const TABLES = ['empresas', 'usuarios', 'reviews', 'password_resets', 'dot_action_queue', 'dot_action_audit'];

test('snapshot de índices captura definições reais e detecta ausência/alteração', async () => {
  const created = await createTestDatabase('pg_index_snapshot');
  const db = await initPgDatabase(created.url);
  try {
    await runCentralMigrations(db);
    const baseline = await listIndexDefinitions(db, TABLES);
    assert.ok(baseline.length > 0);
    for (const index of baseline) {
      assert.ok(index.name.length > 0);
      assert.ok(TABLES.includes(index.table));
      assert.match(index.definition, /^CREATE (UNIQUE )?INDEX /, `definição inválida: ${index.definition}`);
    }

    const unique = baseline.find((index) => index.name === 'idx_usuarios_email');
    assert.equal(unique?.unique, true, 'índice único deve ser identificado pela definição real');
    const partial = baseline.find((index) => index.name === 'ux_dot_action_queue_one_active_decision');
    assert.equal(partial?.unique, true);
    assert.match(String(partial?.definition), /WHERE/i, 'índice parcial deve manter o predicado na definição');

    // Ausência detectada.
    await db.exec('DROP INDEX idx_dot_action_audit_empresa');
    const semIndice = await listIndexDefinitions(db, TABLES);
    assert.equal(semIndice.some((index) => index.name === 'idx_dot_action_audit_empresa'), false);
    assert.notDeepEqual(semIndice, baseline, 'snapshot deve mudar quando um índice desaparece');

    // Definição alterada detectada.
    await db.exec('CREATE INDEX idx_dot_action_audit_empresa ON dot_action_audit(created_at)');
    const alterado = await listIndexDefinitions(db, TABLES);
    const original = baseline.find((index) => index.name === 'idx_dot_action_audit_empresa');
    const diferente = alterado.find((index) => index.name === 'idx_dot_action_audit_empresa');
    assert.ok(original && diferente);
    assert.notEqual(diferente?.definition, original?.definition, 'definição diferente deve ser detectada');
    assert.notDeepEqual(alterado, baseline);

    // Migração restaura a definição canônica quando o índice está ausente.
    await db.exec('DROP INDEX idx_dot_action_audit_empresa');
    await runCentralMigrations(db);
    const restaurado = await listIndexDefinitions(db, TABLES);
    assert.deepEqual(restaurado, baseline, 'segunda inicialização deve restaurar exatamente as definições');
  } finally {
    await db.close();
    await dropTestDatabase(created.name);
  }
});
