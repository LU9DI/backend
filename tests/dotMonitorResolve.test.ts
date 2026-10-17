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

const monitorTest = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !sqliteAvailable }, fn);

import { initDB, getDb } from '../lib/db.js';
import { listDotEvents, runDotMonitor } from '../services/dotMonitor.js';
import { resolveDotComplaint } from '../services/dotResolve.js';

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = '/tmp/filtra-dot-monitor-resolve-test.sqlite';

let ready = false;

async function setup() {
  if (ready) return;
  await initDB();
  const columns = await getDb().all('PRAGMA table_info(reviews)');
  if (!(columns || []).some((column: { name?: string }) => column.name === 'is_test')) {
    throw new Error('initDB deve garantir reviews.is_test (correção A2)');
  }
  ready = true;
}

async function reset() {
  await setup();
  const db = getDb();
  for (const table of ['dot_events', 'dot_decisions', 'dot_action_queue', 'reviews', 'empresas']) {
    try {
      await db.run(`DELETE FROM ${table}`);
    } catch {
      /* tabela criada sob demanda */
    }
  }
}

async function seedEmpresa(empresaId: string) {
  const now = new Date().toISOString();
  await getDb().run(
    'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
    [empresaId, 'cnpj-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14), 'Empresa Monitor', 'slug-' + empresaId.slice(0, 8), 'ativo', 'rei', now, now],
  );
}

async function seedReview(empresaId: string, rating: number, tags: string[]) {
  await getDb().run(
    'INSERT INTO reviews (empresa_id,name,rating,comment,ai_tags,is_test,createdAt) VALUES (?,?,?,?,?,0,?)',
    [empresaId, 'Cliente', rating, 'Demora no atendimento e tempo de espera longo', JSON.stringify(tags), new Date().toISOString()],
  );
}

monitorTest('Monitor do Dot: cria eventos e decisões e não duplica na mesma janela', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  const outra = crypto.randomUUID();
  await seedEmpresa(empresa);
  await seedEmpresa(outra);
  for (let i = 0; i < 6; i += 1) await seedReview(empresa, 2, ['tempo de espera']);

  const first = await runDotMonitor(empresa);
  assert.equal(first.ok, true);
  assert.equal(first.skipped, false);
  assert.equal(first.average, 2);
  assert.equal(first.events.length, 2, 'queda de nota e tema recorrente devem gerar eventos');
  assert.equal(first.decisions.length, 2);

  const types = first.events.map((event: { type: string }) => event.type).sort();
  assert.deepEqual(types, ['rating_drop', 'recurring_theme']);

  // A mesma janela não gera eventos duplicados.
  const second = await runDotMonitor(empresa);
  assert.equal(second.skipped, false);
  assert.equal(second.events.length, 0);
  assert.equal(second.decisions?.length ?? 0, 0);

  // Isolamento por empresa.
  assert.equal((await listDotEvents(empresa)).length, 2);
  assert.equal((await listDotEvents(outra)).length, 0);

  // O monitoramento respeita a autonomia 'observador' sem alertas imediatos.
  const db = getDb();
  await db.run('UPDATE empresas SET dot_preferences_json = ? WHERE id = ?', [JSON.stringify({ autonomy: 'observador', immediateAlerts: false }), empresa]);
  const skipped = await runDotMonitor(empresa);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.events.length, 0);
});

monitorTest('Resolução do Dot: verificação por evidência real e isolamento', async () => {
  await reset();
  const empresa = crypto.randomUUID();
  const outra = crypto.randomUUID();
  await seedEmpresa(empresa);
  await seedEmpresa(outra);
  await seedReview(empresa, 1, ['tempo de espera']);
  await seedReview(empresa, 2, ['tempo de espera']);

  const confirmed = await resolveDotComplaint(empresa, 'O cliente reclamou do tempo de espera');
  assert.equal(confirmed.verification_status, 'confirmed');
  assert.equal(confirmed.confidence, 'alta');
  assert.equal(confirmed.requires_owner_decision, true);
  assert.ok(confirmed.evidence.length >= 2);
  assert.ok(confirmed.facts.length >= 3);
  assert.equal(confirmed.options.length, 2);
  assert.equal(confirmed.options[0].id, 'opcao_1');

  // Relato sem correspondência nas avaliações não é confirmado.
  const notFound = await resolveDotComplaint(empresa, 'assunto completamente diferente sem correspondencia xyz');
  assert.equal(notFound.verification_status, 'not_found');
  assert.equal(notFound.confidence, 'baixa');
  assert.equal(notFound.evidence.length, 0);

  // Empresa sem avaliações não inventa evidência.
  const empty = await resolveDotComplaint(outra, 'tempo de espera');
  assert.equal(empty.verification_status, 'not_found');
  assert.equal(empty.evidence.length, 0);

  await assert.rejects(() => resolveDotComplaint(empresa, '   '), /obrigatório/);
  await assert.rejects(() => resolveDotComplaint('empresa-inexistente', 'tempo de espera'), /não encontrada/);
});
