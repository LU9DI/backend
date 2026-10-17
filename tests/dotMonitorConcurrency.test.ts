/**
 * M2 — operações concorrentes sem duplicação.
 *
 * O monitor e a fila de ações usam check-then-insert; sem transação
 * serializada, rodadas simultâneas podiam duplicar eventos, decisões e ações
 * (ou derrubar a rodada com "cannot start a transaction within a transaction").
 */
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

const concurrencyTest = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !sqliteAvailable }, fn);

import { getDb, initDB } from '../lib/db.js';
import { getDotPreferences } from '../services/dotPreferences.js';
import { runDotMonitor } from '../services/dotMonitor.js';
import { listDotActions, prepareDotActionFromDecision } from '../services/dotActionQueue.js';

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = '/tmp/filtra-dot-concurrency-test.sqlite';

let ready = false;

async function setup() {
  if (ready) return;
  await initDB();
  ready = true;
}

async function reset() {
  await setup();
  const db = getDb();
  for (const table of ['dot_events', 'dot_decisions', 'dot_action_queue', 'dot_followups', 'reviews', 'empresas']) {
    try {
      await db.run(`DELETE FROM ${table}`);
    } catch {
      /* tabela criada sob demanda */
    }
  }
}

async function seedEmpresa(empresaId: string, preferences?: Record<string, unknown>) {
  // Garante a coluna dot_preferences_json (criada sob demanda pelo serviço).
  await getDotPreferences(empresaId);
  const now = new Date().toISOString();
  await getDb().run(
    'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em,dot_preferences_json) VALUES (?,?,?,?,?,?,?,?,?)',
    [empresaId, 'cnpj-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14), 'Empresa Concorrência', 'slug-' + empresaId.slice(0, 8), 'ativo', 'rei', now, now, preferences ? JSON.stringify(preferences) : null],
  );
}

async function seedReview(empresaId: string, rating: number, tags: string[]) {
  await getDb().run(
    'INSERT INTO reviews (empresa_id,name,rating,comment,ai_tags,is_test,createdAt) VALUES (?,?,?,?,?,0,?)',
    [empresaId, 'Cliente', rating, 'Demora no atendimento e tempo de espera longo', JSON.stringify(tags), new Date().toISOString()],
  );
}

concurrencyTest('M2: rodadas concorrentes do monitor não duplicam eventos nem decisões', async () => {
  await setup();
  await reset();
  const empresa = crypto.randomUUID();
  await seedEmpresa(empresa);
  for (let i = 0; i < 6; i += 1) await seedReview(empresa, 2, ['tempo de espera']);

  const rounds = await Promise.all([runDotMonitor(empresa), runDotMonitor(empresa), runDotMonitor(empresa)]);
  for (const round of rounds) assert.equal(round.ok, true);

  const totalEvents = rounds.reduce((sum, round) => sum + (round.events?.length || 0), 0);
  assert.equal(totalEvents, 2, 'a janela de deduplicação vale mesmo com rodadas simultâneas');
  const totalDecisions = rounds.reduce((sum, round) => sum + (round.decisions?.length || 0), 0);
  assert.equal(totalDecisions, 2);

  const db = getDb();
  assert.equal((await db.all('SELECT id FROM dot_events WHERE empresa_id = ?', [empresa])).length, 2);
  assert.equal((await db.all('SELECT id FROM dot_decisions WHERE empresa_id = ?', [empresa])).length, 2);

  // Novas rodadas simultâneas continuam sem duplicar.
  const again = await Promise.all([runDotMonitor(empresa), runDotMonitor(empresa)]);
  for (const round of again) assert.equal(round.events.length, 0);
  assert.equal((await db.all('SELECT id FROM dot_events WHERE empresa_id = ?', [empresa])).length, 2);
});

concurrencyTest('M2: preparação concorrente cria uma única ação por decisão', async () => {
  await setup();
  await reset();
  const empresa = crypto.randomUUID();
  // Sem preparação automática: as ações serão criadas apenas pelas chamadas
  // concorrentes abaixo, exercitando o check-then-insert da fila.
  await seedEmpresa(empresa, { prepareActionsAutomatically: false });
  for (let i = 0; i < 6; i += 1) await seedReview(empresa, 2, ['tempo de espera']);

  const monitor = await runDotMonitor(empresa);
  assert.equal(monitor.events.length, 2);
  assert.equal((monitor.decisions || []).length, 2);
  assert.equal((await listDotActions(empresa)).length, 0);

  const db = getDb();
  const decisions = await db.all('SELECT id, options_json FROM dot_decisions WHERE empresa_id = ? ORDER BY id', [empresa]);
  assert.equal(decisions.length, 2);
  const optionOf = (decision: any) => JSON.parse(decision.options_json)[0].id;

  // Mesma decisão + mesma opção, em paralelo: a trava serializa e reaproveita.
  const same = await Promise.all([
    prepareDotActionFromDecision(empresa, Number(decisions[0].id), optionOf(decisions[0])),
    prepareDotActionFromDecision(empresa, Number(decisions[0].id), optionOf(decisions[0])),
    prepareDotActionFromDecision(empresa, Number(decisions[0].id), optionOf(decisions[0])),
  ]);
  const ids = new Set(same.map((action: any) => Number(action?.id)).filter((id) => id > 0));
  assert.equal(ids.size, 1, 'as três chamadas devem devolver a mesma ação');
  assert.ok([...ids][0] > 0);

  // Decisão distinta, também em paralelo: uma ação própria, sem colisão.
  const other = await Promise.all([
    prepareDotActionFromDecision(empresa, Number(decisions[1].id), optionOf(decisions[1])),
    prepareDotActionFromDecision(empresa, Number(decisions[1].id), optionOf(decisions[1])),
  ]);
  assert.ok(Number(other[0]?.id) > 0);
  assert.equal(Number(other[0]?.id), Number(other[1]?.id));

  const actions = await listDotActions(empresa);
  assert.equal(actions.length, 2, 'exatamente uma ação por decisão');
});
