/**
 * Isolamento de pools: cada `initPgDatabase` captura o próprio `pg.Pool`.
 * Fechar (ou inicializar) uma instância não pode encerrar/alterar as conexões
 * de outra instância já existente.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initPgDatabase } from '../lib/db.pg.js';
import { createTestDatabase, dropTestDatabase } from './helpers/pg-test-utils.js';

test('fechar uma instância PostgreSQL não encerra a outra', async () => {
  const a = await createTestDatabase('pg_instance_a');
  const b = await createTestDatabase('pg_instance_b');
  try {
    const first = await initPgDatabase(a.url);
    const second = await initPgDatabase(b.url);

    await first.exec('CREATE TABLE instancia_a (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT)');
    await second.exec('CREATE TABLE instancia_b (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT)');

    // Inicializar/`fechar` um terceiro banco não pode tocar nas instâncias vivas.
    const third = await initPgDatabase(a.url);
    await third.exec('CREATE TABLE instancia_c (id INTEGER PRIMARY KEY AUTOINCREMENT)');
    await third.close();

    // `second` segue funcionando após fechar a outra instância do banco A.
    await first.close();

    const stillAlive = await second.get<{ ok: number }>('SELECT 1 AS ok');
    assert.equal(stillAlive?.ok, 1, 'a instância B deve continuar respondendo após B fechar A');
    await second.run('INSERT INTO instancia_b (nome) VALUES (?)', ['viva']);
    const rows = await second.all<{ nome: string }>('SELECT nome FROM instancia_b');
    assert.equal(rows.length, 1, 'a instância B deve continuar aceitando escritas');

    // A instância fechada não pode mais ser usada (seu pool foi encerrado).
    await assert.rejects(
      () => first.get('SELECT 1 AS ok'),
      /pool|closed|encerrad|Cannot use a pool/i,
      'a instância fechada deve rejeitar novas operações',
    );

    await second.close();
    await assert.rejects(
      () => second.get('SELECT 1 AS ok'),
      /pool|closed|encerrad|Cannot use a pool/i,
      'a segunda instância também deve encerrar apenas o próprio pool',
    );
  } finally {
    await dropTestDatabase(a.name);
    await dropTestDatabase(b.name);
  }
});

test('exec propaga erros inesperados de catálogo em vez de mascará-los', async () => {
  const created = await createTestDatabase('pg_exec_errors');
  const db = await initPgDatabase(created.url);
  try {
    await db.exec('CREATE TABLE alvo (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT)');

    // 42P07 duplicate_table não pode ser engolido.
    await assert.rejects(() => db.exec('CREATE TABLE alvo (id INTEGER)'), /already exists|42P07/i);
    // 42701 duplicate_column não pode ser engolido.
    await assert.rejects(() => db.exec('ALTER TABLE alvo ADD COLUMN id TEXT'), /already exists|duplicate column|42701/i);
    // 42P01 undefined_table precisa propagar.
    await assert.rejects(
      () => db.exec('ALTER TABLE tabela_inexistente ADD COLUMN a TEXT'),
      /does not exist|42P01/i,
    );
    // 42601 syntax error precisa propagar.
    await assert.rejects(() => db.exec('SELEC 1'), /syntax|42601/i);

    // IF NOT EXISTS continua idempotente quando usado de forma explícita.
    await db.exec('CREATE TABLE IF NOT EXISTS alvo (id INTEGER)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_alvo_nome ON alvo(nome)');
  } finally {
    await db.close();
    await dropTestDatabase(created.name);
  }
});
