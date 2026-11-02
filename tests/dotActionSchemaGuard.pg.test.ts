/**
 * Prova comportamental (não apenas regex) de que os serviços de fila/auditoria
 * do Dot NÃO executam DDL em caminho de requisição: com o schema incompleto,
 * falham explicitamente e não recriam índice/coluna.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeDB, getDb, initDB } from '../lib/db.js';
import { listDotActions } from '../services/dotActionQueue.js';
import { listDotActionAudit, recordDotActionAudit } from '../services/dotActionAudit.js';
import { createTestDatabase, dropTestDatabase } from './helpers/pg-test-utils.js';

test('serviços Dot não executam DDL quando o schema está incompleto', async () => {
  const created = await createTestDatabase('pg_dot_schema_guard');
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = created.url;
  try {
    const db = await initDB();

    // Índice único da fila ausente: listagem falha e não recria o índice.
    await db.exec('DROP INDEX ux_dot_action_queue_decision_option');
    await assert.rejects(
      () => listDotActions('empresa-sem-schema'),
      /ux_dot_action_queue_decision_option/i,
    );
    const index = await db.get(
      "SELECT 1 AS ok FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_dot_action_queue_decision_option'",
    );
    assert.equal(index, undefined, 'serviço não pode recriar índice durante a requisição');

    // Coluna metadata ausente: registro/consulta falham e não alteram a tabela.
    await db.exec('ALTER TABLE dot_action_audit DROP COLUMN metadata');
    await assert.rejects(
      () => recordDotActionAudit({
        empresaId: 'empresa-sem-schema',
        actionId: 1,
        event: 'prepared',
        actorType: 'dot',
      }),
      /dot_action_audit\.metadata/i,
    );
    await assert.rejects(
      () => listDotActionAudit('empresa-sem-schema', 1),
      /dot_action_audit\.metadata/i,
    );
    const column = await db.get(
      "SELECT 1 AS ok FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'dot_action_audit' AND column_name = 'metadata'",
    );
    assert.equal(column, undefined, 'serviço não pode recriar coluna durante a requisição');

    await closeDB();
  } finally {
    await closeDB().catch(() => undefined);
    process.env.DATABASE_URL = previousUrl;
    await dropTestDatabase(created.name);
  }
});
