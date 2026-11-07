/**
 * Ledger do orçamento do Filtra Dot — reserva, finalização, expiração,
 * reconciliação e concorrência (SQLite local).
 *
 * Cobre as garantias que a reserva em memória NÃO dava:
 *  1. reserva durável vinculada ao consumo real em `ai_usage`;
 *  2. retry nunca duplica consumo (idempotência por reserva);
 *  3. resultado ambíguo NUNCA libera a reserva;
 *  4. expiração idempotente e corrida sweep × finalize;
 *  5. liberação só com comprovação de que a chamada não foi enviada;
 *  6. tokens reais e estimados separados;
 *  7. falha de leitura do orçamento falha fechada;
 *  8. alertas sanitizados.
 *
 * Os equivalentes em PostgreSQL real ficam em `tests/dotLedger.pg.test.ts`
 * (exigem DATABASE_URL apontando para uma instância descartável).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

let sqliteAvailable = true;
try {
  await import('sqlite3');
  await import('sqlite');
} catch {
  sqliteAvailable = false;
}

const tmpDb = path.join(os.tmpdir(), `filtra-dot-ledger-${Date.now()}-${process.pid}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = tmpDb;

const suite = sqliteAvailable ? describe : describe.skip;

const EMPRESA_REI = 'empresa-ledger-rei';
const EMPRESA_CORP = 'empresa-ledger-corp';

let ledger: typeof import('../services/dotLedger.js');
let db: any;

async function resetEmpresa(empresaId: string) {
  await db.run('DELETE FROM dot_budget_reservations WHERE empresa_id = ?', [empresaId]);
  await db.run('DELETE FROM ai_usage WHERE empresa_id = ?', [empresaId]);
}

async function usageRows(empresaId: string) {
  return db.all('SELECT tipo, tokens, feature, provider FROM ai_usage WHERE empresa_id = ? ORDER BY id', [empresaId]);
}

suite('Dot ledger — orçamento durável', () => {
  before(async () => {
    const { initDB, getDb } = await import('../lib/db.js');
    await initDB();
    db = getDb();
    ledger = await import('../services/dotLedger.js');
    await ledger.ensureDotLedgerSchema();
    await resetEmpresa(EMPRESA_REI);
    await resetEmpresa(EMPRESA_CORP);
  });

  after(async () => {
    try {
      const { closeDB } = await import('../lib/db.js');
      await closeDB();
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(tmpDb);
    } catch {
      /* ok */
    }
  });

  test('o limite de orçamento do Dot é o da matriz de planos (rei/corporativo, aliases incluídos)', () => {
    assert.equal(ledger.dotFeatureLimitForPlan('rei'), 600_000);
    assert.equal(ledger.dotFeatureLimitForPlan('REI'), 600_000);
    assert.equal(ledger.dotFeatureLimitForPlan('corporativo'), 200_000);
    assert.equal(ledger.dotFeatureLimitForPlan('corp'), 200_000);
    assert.equal(ledger.dotFeatureLimitForPlan('corporate'), 200_000);
    assert.equal(ledger.dotFeatureLimitForPlan('pro'), 0);
    assert.equal(ledger.dotFeatureLimitForPlan('trial'), 0);
  });

  test('reserva debita o orçamento antes da chamada e sobrevive como linha durável', async () => {
    await resetEmpresa(EMPRESA_REI);
    const before = await ledger.getDotBudgetSnapshot(EMPRESA_REI, 'rei');
    assert.equal(before.used, 0);
    assert.equal(before.reserved, 0);

    const reservation = await ledger.reserveDotExecution({ empresaId: EMPRESA_REI, plan: 'rei' });
    assert.equal(reservation.ok, true);
    assert.ok(reservation.reservation?.id);
    assert.equal(reservation.reservation?.status, 'pending');

    const afterReserve = await ledger.getDotBudgetSnapshot(EMPRESA_REI, 'rei');
    assert.equal(afterReserve.reserved, before.response_limit);
    assert.equal(afterReserve.remaining, before.remaining - before.response_limit);

    // "Restart": a leitura vem do banco, não de uma Map em memória.
    const persisted = await db.get(
      'SELECT COUNT(*) AS c FROM dot_budget_reservations WHERE empresa_id = ? AND status = ?',
      [EMPRESA_REI, 'pending'],
    );
    assert.equal(Number(persisted.c), 1);
  });

  test('finalize converte a estimativa em consumo real e vincula a linha de ai_usage', async () => {
    await resetEmpresa(EMPRESA_REI);
    const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA_REI, plan: 'rei' });
    const id = reserved.reservation!.id;

    const finalized = await ledger.finalizeDotReservation({
      empresaId: EMPRESA_REI,
      reservationId: id,
      tokens: 812,
      estimatedTokens: reserved.snapshot.response_limit,
      provider: 'groq',
      tipo: 'filtra_dot_chat',
    });
    assert.equal(finalized.ok, true);
    assert.equal(finalized.reservation?.status, 'settled');
    assert.equal(Number(finalized.reservation?.tokens_real), 812);
    assert.equal(Number(finalized.reservation?.tokens_estimated), reserved.snapshot.response_limit);
    assert.ok(finalized.reservation?.ai_usage_id, 'reserva precisa apontar para o consumo real');

    const rows = await usageRows(EMPRESA_REI);
    assert.equal(rows.length, 1);
    // Consumo cobrado = tokens REAIS informados pelo provedor. O teto da
    // reserva nunca é debitado: ele é apenas a barreira de admissão.
    assert.equal(Number(rows[0].tokens), 812);
    assert.equal(rows[0].feature, 'dot');
    assert.equal(rows[0].provider, 'groq');

    const snapshot = await ledger.getDotBudgetSnapshot(EMPRESA_REI, 'rei');
    assert.equal(snapshot.used, 812);
    assert.equal(snapshot.reserved, 0);
  });

  test('retry de finalize não duplica consumo', async () => {
    await resetEmpresa(EMPRESA_REI);
    const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA_REI, plan: 'rei' });
    const id = reserved.reservation!.id;

    const first = await ledger.finalizeDotReservation({ empresaId: EMPRESA_REI, reservationId: id, tokens: 500, provider: 'groq' });
    const second = await ledger.finalizeDotReservation({ empresaId: EMPRESA_REI, reservationId: id, tokens: 500, provider: 'groq' });
    const third = await ledger.finalizeDotReservation({ empresaId: EMPRESA_REI, reservationId: id, tokens: 900, provider: 'groq' });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(third.duplicate, true);

    const rows = await usageRows(EMPRESA_REI);
    assert.equal(rows.length, 1, 'retry não pode criar segunda linha de consumo');
    assert.equal(Number(rows[0].tokens), 500, 'sem estimativa informada, o consumo é o real');
    const snapshot = await ledger.getDotBudgetSnapshot(EMPRESA_REI, 'rei');
    assert.equal(snapshot.used, 500);
  });

  test('finalize concorrente (mesma reserva, 5 chamadas) grava exatamente um consumo', async () => {
    await resetEmpresa(EMPRESA_REI);
    const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA_REI, plan: 'rei' });
    const id = reserved.reservation!.id;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ledger.finalizeDotReservation({ empresaId: EMPRESA_REI, reservationId: id, tokens: 321, provider: 'gemini' }),
      ),
    );
    assert.equal(results.filter((r) => r.ok).length, 5);
    assert.equal(results.filter((r) => !r.duplicate).length, 1, 'exatamente uma chamada registra o consumo');

    const rows = await usageRows(EMPRESA_REI);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].tokens), 321);
  });

  test('resultado ambíguo mantém a reserva aberta e NÃO registra consumo', async () => {
    await resetEmpresa(EMPRESA_REI);
    const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA_REI, plan: 'rei' });
    const id = reserved.reservation!.id;

    const ambiguous = await ledger.finalizeDotReservation({
      empresaId: EMPRESA_REI,
      reservationId: id,
      tokens: null,
      estimatedTokens: reserved.snapshot.response_limit,
      ambiguous: true,
      ambiguousReason: 'timeout do provedor após envio',
    });
    assert.equal(ambiguous.ok, true);
    assert.equal(ambiguous.reservation?.status, 'pending');
    assert.equal(Number(ambiguous.reservation?.ambiguous), 1);
    assert.equal(ambiguous.reservation?.ai_usage_id ?? null, null);
    assert.equal((await usageRows(EMPRESA_REI)).length, 0, 'resultado ambíguo não pode virar consumo definitivo');

    // A capacidade continua comprometida.
    const snapshot = await ledger.getDotBudgetSnapshot(EMPRESA_REI, 'rei');
    assert.equal(snapshot.ambiguous, reserved.snapshot.response_limit);
    assert.ok(snapshot.reserved >= reserved.snapshot.response_limit);
  });

  test('reserva ambígua permanece comprometida mesmo 48h após expirar', async () => {
    await resetEmpresa(EMPRESA_REI);
    const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA_REI, plan: 'rei' });
    const id = reserved.reservation!.id;
    await ledger.finalizeDotReservation({
      empresaId: EMPRESA_REI,
      reservationId: id,
      ambiguous: true,
      estimatedTokens: reserved.snapshot.response_limit,
    });
    // Força o vencimento.
    await db.run(
      'UPDATE dot_budget_reservations SET expires_at = ? WHERE empresa_id = ? AND id = ?',
      [new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), EMPRESA_REI, id],
    );
    const swept = await ledger.sweepExpiredDotReservations({ empresaId: EMPRESA_REI });
    assert.equal(swept.expired, 0, 'reserva ambígua não pode ser expirada');
    assert.equal(swept.ambiguous_held, 1);
    const row = await ledger.getDotReservation(EMPRESA_REI, id);
    assert.equal(row?.status, 'pending');
  });

  test('reserva não ambígua vencida é expirada de forma idempotente', async () => {
    await resetEmpresa(EMPRESA_REI);
    const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA_REI, plan: 'rei' });
    const id = reserved.reservation!.id;
    await db.run(
      'UPDATE dot_budget_reservations SET expires_at = ? WHERE empresa_id = ? AND id = ?',
      [new Date(Date.now() - 60_000).toISOString(), EMPRESA_REI, id],
    );
    const first = await ledger.sweepExpiredDotReservations({ empresaId: EMPRESA_REI });
    const second = await ledger.sweepExpiredDotReservations({ empresaId: EMPRESA_REI });
    assert.equal(first.expired, 1);
    assert.equal(second.expired, 0, 'a segunda varredura não pode recontar a mesma reserva');
    const row = await ledger.getDotReservation(EMPRESA_REI, id);
    assert.equal(row?.status, 'expired');
    const snapshot = await ledger.getDotBudgetSnapshot(EMPRESA_REI, 'rei');
    assert.equal(snapshot.reserved, 0, 'reserva expirada deixa de comprometer o orçamento');
  });

  test('corrida sweep × finalize: uma única transição vence e o consumo não se perde', async () => {
    await resetEmpresa(EMPRESA_REI);
    const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA_REI, plan: 'rei' });
    const id = reserved.reservation!.id;
    await db.run(
      'UPDATE dot_budget_reservations SET expires_at = ? WHERE empresa_id = ? AND id = ?',
      [new Date(Date.now() - 1_000).toISOString(), EMPRESA_REI, id],
    );

    const [finalized] = await Promise.all([
      ledger.finalizeDotReservation({ empresaId: EMPRESA_REI, reservationId: id, tokens: 700, provider: 'groq' }),
      ledger.sweepExpiredDotReservations({ empresaId: EMPRESA_REI }),
      ledger.sweepExpiredDotReservations({ empresaId: EMPRESA_REI }),
    ]);

    const row = await ledger.getDotReservation(EMPRESA_REI, id);
    assert.ok(['settled', 'expired'].includes(String(row?.status)));
    if (row?.status === 'settled') {
      assert.equal(finalized.ok, true);
      const rows = await usageRows(EMPRESA_REI);
      assert.equal(rows.length, 1, 'finalize que venceu a corrida registra o consumo uma única vez');
    } else {
      // A varredura venceu: a reserva foi liberada por tempo e o finalize
      // recusa-se a reabri-la (nunca cria consumo sobre reserva encerrada).
      assert.equal(finalized.ok, false);
      assert.equal((await usageRows(EMPRESA_REI)).length, 0);
    }
  });

  test('liberação só é aceita com comprovação de que a chamada não foi enviada', async () => {
    await resetEmpresa(EMPRESA_REI);
    const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA_REI, plan: 'rei' });
    const id = reserved.reservation!.id;

    const refused = await ledger.releaseDotReservation({
      empresaId: EMPRESA_REI,
      reservationId: id,
      provenNotSent: false,
      reason: 'sem prova',
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reservation?.status, 'pending');

    const accepted = await ledger.releaseDotReservation({
      empresaId: EMPRESA_REI,
      reservationId: id,
      provenNotSent: true,
      reason: 'nenhum provedor configurado',
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.reservation?.status, 'released');
    const snapshot = await ledger.getDotBudgetSnapshot(EMPRESA_REI, 'rei');
    assert.equal(snapshot.reserved, 0);
  });

  test('reconciliação: settle com tokens reais fecha a reserva ambígua', async () => {
    await resetEmpresa(EMPRESA_REI);
    const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA_REI, plan: 'rei' });
    const id = reserved.reservation!.id;
    await ledger.finalizeDotReservation({ empresaId: EMPRESA_REI, reservationId: id, ambiguous: true, estimatedTokens: 300 });

    const reconciled = await ledger.reconcileDotBudget({
      empresaId: EMPRESA_REI,
      reservationId: id,
      decision: 'settle',
      tokens: 260,
      provider: 'groq',
    });
    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.reservation?.status, 'settled');
    const rows = await usageRows(EMPRESA_REI);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].tokens), 260, 'reconciliação registra o consumo real informado pelo operador');
  });

  test('reconciliação: release encerra a reserva ambígua sem consumo', async () => {
    await resetEmpresa(EMPRESA_REI);
    const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA_REI, plan: 'rei' });
    const id = reserved.reservation!.id;
    await ledger.finalizeDotReservation({ empresaId: EMPRESA_REI, reservationId: id, ambiguous: true, estimatedTokens: 300 });

    const reconciled = await ledger.reconcileDotBudget({
      empresaId: EMPRESA_REI,
      reservationId: id,
      decision: 'release',
      reason: 'comprovado que o provedor não recebeu a requisição',
    });
    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.reservation?.status, 'released');
    assert.equal((await usageRows(EMPRESA_REI)).length, 0);
    const snapshot = await ledger.getDotBudgetSnapshot(EMPRESA_REI, 'rei');
    assert.equal(snapshot.ambiguous, 0);
    assert.equal(snapshot.reserved, 0);
  });

  test('orçamento esgotado recusa a reserva com DOT_TOKEN_LIMIT', async () => {
    await resetEmpresa(EMPRESA_CORP);
    // Consumo real próximo do limite do Corporativo (200k).
    await db.run(
      "INSERT INTO ai_usage (empresa_id, tipo, tokens, provider, feature, criado_em) VALUES (?,?,?,?,?,datetime('now'))",
      [EMPRESA_CORP, 'filtra_dot_chat', 199_950, 'groq', 'dot'],
    );
    const refused = await ledger.reserveDotExecution({ empresaId: EMPRESA_CORP, plan: 'corporativo' });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'DOT_TOKEN_LIMIT');
    assert.equal(refused.snapshot.limit, 200_000);
    assert.ok(refused.snapshot.remaining < refused.snapshot.response_limit);
  });

  test('o consumo do Dot não é somado ao orçamento de reviews (isolamento de feature)', async () => {
    await resetEmpresa(EMPRESA_REI);
    await db.run(
      "INSERT INTO ai_usage (empresa_id, tipo, tokens, provider, feature, criado_em) VALUES (?,?,?,?,?,datetime('now'))",
      [EMPRESA_REI, 'filtra_dot_chat', 12_000, 'groq', 'dot'],
    );
    await db.run(
      "INSERT INTO ai_usage (empresa_id, tipo, tokens, provider, feature, criado_em) VALUES (?,?,?,?,?,datetime('now'))",
      [EMPRESA_REI, 'review_reply', 4_000, 'groq', null],
    );
    const { tokensUsadosMes } = await import('../lib/quota.js');
    const reviews = await tokensUsadosMes(EMPRESA_REI);
    assert.equal(reviews, 4_000, 'reviews contam apenas as linhas sem feature');
    const snapshot = await ledger.getDotBudgetSnapshot(EMPRESA_REI, 'rei');
    assert.equal(snapshot.used, 12_000, 'o Dot conta apenas as linhas da própria feature');
  });

  test('alertas são emitidos por faixa e nunca carregam dado sensível', () => {
    const exhausted = ledger.buildDotBudgetAlert({
      empresa_id: 'x',
      plan: 'rei',
      feature: 'dot',
      limit: 1000,
      feedback_limit: 0,
      used: 1000,
      reserved: 0,
      ambiguous: 0,
      remaining: 0,
      response_limit: 900,
      warning: false,
      exhausted: true,
      percent: 1,
      pending_reservations: 0,
    });
    assert.equal(exhausted?.event, 'dot_budget_exhausted');
    assert.equal(exhausted?.severity, 'critical');

    const warning = ledger.buildDotBudgetAlert({
      empresa_id: 'x',
      plan: 'rei',
      feature: 'dot',
      limit: 1000,
      feedback_limit: 0,
      used: 850,
      reserved: 0,
      ambiguous: 0,
      remaining: 150,
      response_limit: 900,
      warning: true,
      exhausted: false,
      percent: 0.85,
      pending_reservations: 0,
    });
    assert.equal(warning?.event, 'dot_budget_warning');
    assert.equal(warning?.severity, 'warning');

    const ambiguous = ledger.buildDotBudgetAlert({
      empresa_id: 'x',
      plan: 'rei',
      feature: 'dot',
      limit: 1000,
      feedback_limit: 0,
      used: 10,
      reserved: 300,
      ambiguous: 300,
      remaining: 690,
      response_limit: 900,
      warning: false,
      exhausted: false,
      percent: 0.31,
      pending_reservations: 1,
    });
    assert.equal(ambiguous?.event, 'dot_budget_ambiguous');

    const healthy = ledger.buildDotBudgetAlert({
      empresa_id: 'x',
      plan: 'rei',
      feature: 'dot',
      limit: 1000,
      feedback_limit: 0,
      used: 10,
      reserved: 0,
      ambiguous: 0,
      remaining: 990,
      response_limit: 900,
      warning: false,
      exhausted: false,
      percent: 0.01,
      pending_reservations: 0,
    });
    assert.equal(healthy, null);

    const sanitized = ledger.sanitizeDotAlertText(
      'falha para cliente@exemplo.com tel +55 (11) 98888-7777 chave gsk_abcdefghijklmnop Bearer abcdefghijklmnopqrstuvwxyz012345',
    );
    assert.ok(!sanitized.includes('cliente@exemplo.com'));
    assert.ok(!sanitized.includes('98888'));
    assert.ok(!sanitized.includes('gsk_abcdefghijklmnop'));
    assert.ok(!sanitized.includes('abcdefghijklmnopqrstuvwxyz012345'));
    assert.ok(sanitized.includes('[REDACTED_EMAIL]'));
    assert.ok(sanitized.includes('[REDACTED_PHONE]'));
  });

  test('snapshot falha fechado quando a leitura do orçamento quebra', async () => {
    const { initDB, getDb } = await import('../lib/db.js');
    const original = getDb().all;
    getDb().all = async () => {
      throw new Error('falha simulada de leitura');
    };
    try {
      const snapshot = await ledger.getDotBudgetSnapshot(EMPRESA_REI, 'rei');
      assert.equal(snapshot.exhausted, true);
      assert.equal(snapshot.remaining, 0);
      const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA_REI, plan: 'rei' });
      assert.equal(reserved.ok, false, 'falha de leitura NUNCA autoriza execução');
      // Falha de banco é INDISPONIBILIDADE, não orçamento esgotado: a rota
      // responde 503 (não 429) e nenhuma reserva é criada.
      assert.equal(reserved.code, 'DOT_BUDGET_UNAVAILABLE');
      assert.equal(reserved.unavailable, true);
      assert.equal(reserved.snapshot.exhausted, true);
      assert.equal(reserved.snapshot.remaining, 0);
    } finally {
      getDb().all = original;
      void initDB;
    }
  });

  test('a reserva de uma empresa nunca é visível para outra', async () => {
    await resetEmpresa(EMPRESA_REI);
    await resetEmpresa(EMPRESA_CORP);
    const reserved = await ledger.reserveDotExecution({ empresaId: EMPRESA_REI, plan: 'rei' });
    const id = reserved.reservation!.id;
    const foreign = await ledger.getDotReservation(EMPRESA_CORP, id);
    assert.equal(foreign, null);
    const foreignFinalize = await ledger.finalizeDotReservation({ empresaId: EMPRESA_CORP, reservationId: id, tokens: 10 });
    assert.equal(foreignFinalize.ok, false);
    const snapshot = await ledger.getDotBudgetSnapshot(EMPRESA_CORP, 'corporativo');
    assert.equal(snapshot.reserved, 0);
  });
});
