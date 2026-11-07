/**
 * Contabilidade única — `callAI` NÃO grava uso quando o Dot reserva.
 *
 * O fluxo do Dot tem duas saídas possíveis no `groqService`:
 *   - sem `skipUsageRecord`: o próprio serviço grava `ai_usage` (legado,
 *     demais consumidores);
 *   - com `skipUsageRecord: true` (fluxo do Dot): nada é gravado aqui — o
 *     ledger (`finalizeDotReservation`) grava UMA linha por reserva.
 *
 * O teste usa `fetch` simulado (nenhuma chamada real ao provedor).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

const tmpDb = path.join(os.tmpdir(), `filtra-ai-usage-dedup-${Date.now()}-${process.pid}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.GROQ_API_KEY = 'gsk_test_000000000000';
process.env.GEMINI_API_KEY = '';
process.env.AI_PROVIDER_ORDER = 'groq';

const EMPRESA = 'ai-usage-dedup-co';

let db: any;
let realFetch: typeof fetch | undefined;

async function usageRows() {
  return db.all('SELECT tokens, tokens_input, tokens_output, feature FROM ai_usage WHERE empresa_id = ?', [EMPRESA]);
}

async function withFakeProvider(usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      choices: [{ message: { content: 'resposta simulada' } }],
      usage,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch;
}

describe('callAI — contabilidade única', () => {
  before(async () => {
    const { initDB, getDb } = await import('../lib/db.js');
    await initDB();
    db = getDb();
  });

  beforeEach(async () => {
    await db.run('DELETE FROM ai_usage WHERE empresa_id = ?', [EMPRESA]);
    delete process.env.DOT_DEMO_MODE;
  });

  after(async () => {
    if (realFetch) globalThis.fetch = realFetch;
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

  test('callAI sem skipUsageRecord grava UMA linha com tokens de entrada/saída', async () => {
    await withFakeProvider({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    try {
      const { callAI } = await import('../groqService.js');
      const result = await callAI('sistema', 'usuário', 50, 0.1, {
        empresaId: EMPRESA,
        tipo: 'filtra_dot_chat',
        feature: 'dot',
      });
      assert.equal(result.tokens, 18);
      assert.equal(result.input_tokens, 11);
      assert.equal(result.output_tokens, 7);
      const rows = await usageRows();
      assert.equal(rows.length, 1);
      assert.equal(Number(rows[0].tokens), 18);
      assert.equal(Number(rows[0].tokens_input), 11);
      assert.equal(Number(rows[0].tokens_output), 7);
    } finally {
      if (realFetch) globalThis.fetch = realFetch;
    }
  });

  test('callAI com skipUsageRecord não grava nada — o ledger é a fonte única', async () => {
    await withFakeProvider({ prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 });
    try {
      const { callAI } = await import('../groqService.js');
      const result = await callAI('sistema', 'usuário', 50, 0.1, {
        empresaId: EMPRESA,
        tipo: 'filtra_dot_chat',
        feature: 'dot',
        skipUsageRecord: true,
      });
      assert.equal(result.tokens, 50);
      assert.equal(result.input_tokens, 30);
      assert.equal(result.output_tokens, 20);
      const rows = await usageRows();
      assert.equal(rows.length, 0, 'o fluxo do Dot nunca duplica a gravação em ai_usage');
    } finally {
      if (realFetch) globalThis.fetch = realFetch;
    }
  });

  test('setCallAIImpl: ativo em NODE_ENV=test e recusado fora dele', async () => {
    const groq: any = await import('../groqService.js');
    let called = 0;
    groq.setCallAIImpl(async () => {
      called += 1;
      return { text: 'duplo', provider: 'test', latency_ms: 0, tokens: 1, model: 'test', input_tokens: 0, output_tokens: 0 };
    });
    try {
      const result = await groq.callAI('s', 'u', 10, 0.1, {});
      assert.equal(called, 1, 'em teste o duplo é usado');
      assert.equal(result.text, 'duplo');
    } finally {
      groq.setCallAIImpl(null);
    }

    // Fora de teste o hook é recusado: nenhum gancho de teste em produção.
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(() => groq.setCallAIImpl(async () => ({} as any)), /exclusivo de ambiente de teste/i);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
