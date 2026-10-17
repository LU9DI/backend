import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

let sqliteAvailable = true;
try {
  await import('sqlite3');
  await import('sqlite');
} catch {
  sqliteAvailable = false;
}

const unidadesTest = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !sqliteAvailable }, fn);

import { initDB, getDb } from '../lib/db.js';
import { ensureReviewTreatmentColumns } from '../lib/lgpd.js';
import { ensureUnidadesSchema } from '../lib/unidades.js';
import { buildRelatorioProfissional } from '../services/relatorioProfissional.js';

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = '/tmp/filtra-relatorio-unidades-test.sqlite';

let ready = false;

async function setup() {
  if (ready) return;
  await initDB();
  const db = getDb();
  // Mesmas migrações idempotentes que o boot do servidor aplica.
  await ensureReviewTreatmentColumns(db);
  await ensureUnidadesSchema(db);
  for (const ddl of ['sentiment TEXT', 'origin TEXT', 'unidade_id TEXT']) {
    try { await db.exec(`ALTER TABLE reviews ADD COLUMN ${ddl}`); } catch { /* já existe */ }
  }
  ready = true;
}

unidadesTest('Relatório profissional: unidades reais aparecem mesmo sem coluna slug (regressão B1)', async () => {
  await setup();
  const db = getDb();
  const mes = '2026-09';
  const empresa = crypto.randomUUID();
  const unidadeCentro = crypto.randomUUID();
  const unidadeNorte = crypto.randomUUID();

  // Premissa do defeito: o schema real NÃO tem coluna slug. A query antiga
  // (`SELECT id, nome, slug FROM unidades`) falhava e o catch silencioso
  // esvaziava a seção de unidades do relatório.
  const slugAusente = await db
    .get('SELECT id, nome, slug FROM unidades LIMIT 1')
    .then(() => false)
    .catch(() => true);
  assert.equal(slugAusente, true, 'o schema real não deve ter coluna slug — se isso mudou, revise o teste');

  await db.run('INSERT INTO unidades (id,empresa_id,nome,ativo) VALUES (?,?,?,1)', [unidadeCentro, empresa, 'Loja Centro']);
  await db.run('INSERT INTO unidades (id,empresa_id,nome,ativo) VALUES (?,?,?,1)', [unidadeNorte, empresa, 'Loja Norte']);

  const addReview = (rating: number, opts: any = {}) =>
    db.run(
      'INSERT INTO reviews (empresa_id,name,rating,comment,ai_tags,is_test,createdAt,unidade_id,origin,treated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [empresa, 'Cliente', rating, 'comentario', JSON.stringify(opts.tags || []), 0, `${mes}-10T12:00:00.000Z`, opts.unidade_id || null, opts.origin || null, null],
    );

  // Centro: uma avaliação vinculada por unidade_id e outra apenas por
  // origin = slug derivado do nome ("loja-centro").
  await addReview(5, { unidade_id: unidadeCentro, origin: 'loja-centro' });
  await addReview(4, { origin: 'loja-centro' });
  // Norte: uma crítica vinculada por unidade_id.
  await addReview(1, { unidade_id: unidadeNorte, origin: 'loja-norte' });

  const rel = await buildRelatorioProfissional(db, { id: empresa, nome_empresa: 'Rede Teste', plan: 'rei', slug: 'rede-teste' }, mes);

  assert.equal(rel.kpis.avaliacoes, 3);
  const unidades = rel.unidades as Array<{ id: string; nome: string; avaliacoes: number; nota_media: number; criticas: number }>;
  assert.equal(unidades.length, 2, 'as duas unidades reais precisam aparecer no relatório');

  const centro = unidades.find((u) => u.nome === 'Loja Centro');
  const norte = unidades.find((u) => u.nome === 'Loja Norte');
  assert.ok(centro, 'unidade Loja Centro presente');
  assert.ok(norte, 'unidade Loja Norte presente');
  assert.equal(centro.avaliacoes, 2, 'avaliação com origin = slug do nome precisa entrar na unidade');
  assert.equal(centro.nota_media, 4.5);
  assert.equal(norte.avaliacoes, 1);
  assert.equal(norte.criticas, 1);
});
