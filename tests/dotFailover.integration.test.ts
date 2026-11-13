/**
 * Integração real do fluxo de failover de IA com o ledger durável do Dot:
 * reserva → marca de envio → chamada aos provedores (fetch stub) → classificação
 * → finalização (sucesso) ou liberação/marcação ambígua (falha).
 *
 * Não usa `setCallAIImpl`: o caminho exercitado é o `callAI` real, com dois
 * provedores em failover e `fetch` controlado. O que se prova aqui:
 *  - todas as tentativas são preservadas no AggregateError;
 *  - um erro ambíguo anterior nunca é apagado por uma recusa posterior;
 *  - só há liberação quando TODAS as tentativas são recusas estruturadas;
 *  - reserva sem transição válida (`markDotReservationSent` = 0 linhas) não
 *    chega ao provedor;
 *  - sucesso no provedor de fallback finaliza com os tokens reais;
 *  - nenhuma cobrança/consumo duplicado.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

const tmpDb = path.join(os.tmpdir(), `filtra-dot-failover-${Date.now()}-${process.pid}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.GROQ_API_KEY = 'test-groq-key';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.AI_PROVIDER_ORDER = 'groq,gemini';
process.env.AI_LOAD_BALANCE = 'failover';
process.env.AI_CB_FAILURES = '999';
process.env.DOT_SENT_GRACE_MS = '600000';

const suite = sqliteAvailable ? describe : describe.skip;

let ledger: typeof import('../services/dotLedger.js');
let groq: typeof import('../groqService.js');
let settleDotCallFailure: typeof import('../routes/dotRoutes.js').settleDotCallFailure;
let db: any;

const originalFetch = globalThis.fetch;
const GROQ_OK = JSON.stringify({
  choices: [{ message: { content: 'resposta groq' } }],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
});
const GEMINI_OK = JSON.stringify({
  candidates: [{ content: { parts: [{ text: 'resposta gemini' }] } }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
});

function stubProviders(routes: { groq?: { status: number; body: string }; gemini?: { status: number; body: string } }) {
  globalThis.fetch = (async (input: any) => {
    const url = String(typeof input === 'string' ? input : input?.url || '');
    const reply = /groq\.com/i.test(url) ? routes.groq : routes.gemini;
    if (!reply) throw new Error('fetch inesperado para URL: ' + url);
    return new Response(reply.body, {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
}

function tenant(): string {
  return `failover-${crypto.randomUUID()}`;
}

async function reserveAndMark(empresaId: string): Promise<number> {
  const reserved = await ledger.reserveDotExecution({
    empresaId,
    plan: 'rei',
    executionRef: `it:${empresaId}:${Date.now()}`,
  });
  assert.ok(reserved.ok && reserved.reservation, 'reserva deveria ser criada');
  const id = reserved.reservation.id;
  const marked = await ledger.markDotReservationSent({ empresaId, reservationId: id });
  assert.equal(marked.ok, true, 'marca de envio deveria transicionar a reserva pending');
  return id;
}

async function callProviders(empresaId: string) {
  return groq.callAI('system', 'user', 200, 0.2, {
    empresaId,
    tipo: 'filtra_dot_chat',
    feature: 'dot',
    skipUsageRecord: true,
  });
}

async function usageRows(empresaId: string) {
  return db.all('SELECT tokens, provider, feature FROM ai_usage WHERE empresa_id = ? ORDER BY id', [empresaId]);
}

async function reservation(empresaId: string, id: number) {
  return db.get('SELECT * FROM dot_budget_reservations WHERE empresa_id = ? AND id = ?', [empresaId, id]);
}

suite('Dot + failover de IA — integração com o ledger', () => {
  before(async () => {
    const { initDB, getDb } = await import('../lib/db.js');
    await initDB();
    db = getDb();
    ledger = await import('../services/dotLedger.js');
    await ledger.ensureDotLedgerSchema();
    groq = await import('../groqService.js');
    settleDotCallFailure = (await import('../routes/dotRoutes.js')).settleDotCallFailure;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    try {
      const { closeDB } = await import('../lib/db.js');
      await closeDB();
    } catch {
      /* ok */
    }
  });

  test('ambíguo no provedor primário sobrevive à recusa posterior: nada é liberado', async () => {
    const empresaId = tenant();
    const id = await reserveAndMark(empresaId);
    stubProviders({
      groq: { status: 503, body: 'upstream failure' },
      gemini: { status: 401, body: 'invalid key' },
    });

    let captured: any = null;
    try {
      await callProviders(empresaId);
      assert.fail('a chamada deveria falhar nos dois provedores');
    } catch (error) {
      captured = error;
    }
    assert.ok(captured instanceof AggregateError, 'deve agregar as tentativas');
    assert.equal((captured as any).errors.length, 2, 'todas as tentativas preservadas');
    assert.equal((captured as any).status, 401, 'status do último erro preservado');
    assert.match(String((captured as any).message), /Gemini API error 401/);

    await settleDotCallFailure({
      error: captured,
      providerCalled: true,
      empresaId,
      reservationId: id,
      reservedTokens: 200,
    });

    const row = await reservation(empresaId, id);
    assert.equal(String(row.status), 'pending', 'reserva ambígua continua pending');
    assert.equal(Number(row.ambiguous), 1);
    assert.ok(row.sent_at, 'marca de envio preservada');
    assert.deepEqual(await usageRows(empresaId), [], 'nenhum consumo registrado');

    // Sweep após a carência não expira nem libera reserva potencialmente cobrada.
    process.env.DOT_SENT_GRACE_MS = '0';
    try {
      await db.run(
        'UPDATE dot_budget_reservations SET expires_at = ? WHERE empresa_id = ? AND id = ?',
        [new Date(Date.now() - 60_000).toISOString(), empresaId, id],
      );
      const swept = await ledger.sweepExpiredDotReservations({ empresaId });
      assert.equal(swept.expired, 0, 'reserva enviada nunca é expirada');
      assert.equal(swept.ambiguous_marked, 0, 'já marcada ambígua pelo settle');
      assert.equal(swept.ambiguous_held, 1, 'continua comprometendo o orçamento');
      assert.equal(String((await reservation(empresaId, id)).status), 'pending');
    } finally {
      process.env.DOT_SENT_GRACE_MS = '600000';
    }
  });

  test('todas as tentativas recusadas: libera uma única vez e sem consumo', async () => {
    const empresaId = tenant();
    const id = await reserveAndMark(empresaId);
    stubProviders({
      groq: { status: 401, body: 'invalid key' },
      gemini: { status: 403, body: 'forbidden' },
    });

    let captured: any = null;
    try {
      await callProviders(empresaId);
      assert.fail('a chamada deveria falhar nos dois provedores');
    } catch (error) {
      captured = error;
    }

    const { classifyDotProviderError, isProvenNotSent } = await import('../services/dotProviderOutcome.js');
    assert.equal(classifyDotProviderError(captured), 'rejected');
    assert.equal(isProvenNotSent('rejected', captured), true);

    await settleDotCallFailure({
      error: captured,
      providerCalled: true,
      empresaId,
      reservationId: id,
      reservedTokens: 200,
    });
    const row = await reservation(empresaId, id);
    assert.equal(String(row.status), 'released');
    assert.deepEqual(await usageRows(empresaId), []);

    // Repetir a liberação continua sem criar consumo (idempotente).
    await settleDotCallFailure({
      error: captured,
      providerCalled: true,
      empresaId,
      reservationId: id,
      reservedTokens: 200,
    });
    assert.equal(String((await reservation(empresaId, id)).status), 'released');
    assert.deepEqual(await usageRows(empresaId), []);
  });

  test('sucesso no provedor de fallback finaliza com tokens reais (uma única vez)', async () => {
    const empresaId = tenant();
    const id = await reserveAndMark(empresaId);
    stubProviders({
      groq: { status: 503, body: 'overloaded' },
      gemini: { status: 200, body: GEMINI_OK },
    });

    const result = await callProviders(empresaId);
    assert.equal(result.provider, 'gemini');
    assert.equal(result.tokens, 30);
    assert.equal(result.input_tokens, 10);
    assert.equal(result.output_tokens, 20);

    const finalized = await ledger.finalizeDotReservation({
      empresaId,
      reservationId: id,
      tokens: result.tokens,
      inputTokens: result.input_tokens,
      outputTokens: result.output_tokens,
      provider: result.provider,
      tipo: 'filtra_dot_chat',
    });
    assert.equal(finalized.ok, true);
    const row = await reservation(empresaId, id);
    assert.equal(String(row.status), 'settled');
    assert.equal(Number(row.tokens_real), 30);
    const usage = await usageRows(empresaId);
    assert.equal(usage.length, 1, 'um único consumo');
    assert.equal(Number(usage[0].tokens), 30);
    assert.equal(usage[0].provider, 'gemini');

    // Retry de finalização não duplica consumo.
    const again = await ledger.finalizeDotReservation({
      empresaId,
      reservationId: id,
      tokens: 30,
      provider: 'gemini',
      tipo: 'filtra_dot_chat',
    });
    assert.equal(again.ok, true);
    assert.equal(again.duplicate, true);
    assert.equal((await usageRows(empresaId)).length, 1);
  });

  test('reserva sem transição válida não é enviada ao provedor', async () => {
    const empresaId = tenant();
    const reserved = await ledger.reserveDotExecution({ empresaId, plan: 'rei' });
    assert.ok(reserved.ok && reserved.reservation);
    const id = reserved.reservation.id;
    // Simula reserva expirada/liberada por outro caminho antes da marca de envio.
    await db.run(
      "UPDATE dot_budget_reservations SET status = 'expired' WHERE empresa_id = ? AND id = ?",
      [empresaId, id],
    );
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('não deveria chamar o provedor');
    }) as any;

    const marked = await ledger.markDotReservationSent({ empresaId, reservationId: id });
    assert.equal(marked.ok, false, 'marca de envio deve recusar reserva não-pending');
    assert.equal(fetchCalls, 0);
    const row = await reservation(empresaId, id);
    assert.equal(String(row.status), 'expired');
    assert.equal(row.sent_at ?? null, null);
  });

  test('provedor primário com sucesso não aciona fallback nem duplica consumo', async () => {
    const empresaId = tenant();
    const id = await reserveAndMark(empresaId);
    stubProviders({
      groq: { status: 200, body: GROQ_OK },
      gemini: { status: 200, body: GEMINI_OK },
    });
    const result = await callProviders(empresaId);
    assert.equal(result.provider, 'groq');
    assert.equal(result.tokens, 12);
    await ledger.finalizeDotReservation({
      empresaId,
      reservationId: id,
      tokens: result.tokens,
      inputTokens: result.input_tokens,
      outputTokens: result.output_tokens,
      provider: result.provider,
      tipo: 'filtra_dot_chat',
    });
    const usage = await usageRows(empresaId);
    assert.equal(usage.length, 1);
    assert.equal(Number(usage[0].tokens), 12);
    assert.equal(usage[0].provider, 'groq');
  });

  test('buildProviderAggregateError preserva status/código/mensagem do erro final', () => {
    const first: any = new Error('Groq API error 503: upstream failure');
    first.status = 503;
    first.body = 'upstream';
    const last: any = new Error('Gemini API error 429: rate limit');
    last.status = 429;
    last.code = 'RATE_LIMIT';
    last.body = 'rate limit';
    const aggregate: any = groq.buildProviderAggregateError([first, last]);
    assert.equal(aggregate.errors.length, 2);
    assert.equal(aggregate.status, 429);
    assert.equal(aggregate.code, 'RATE_LIMIT');
    assert.equal(aggregate.body, 'rate limit');
    assert.match(aggregate.message, /Gemini API error 429/);
  });
});
