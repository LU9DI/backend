/**
 * HTTP-level acceptance tests for `docs/DOT_HTTP_IDEMPOTENCY.md`.
 *
 * Uses the real Express routes and a simulated provider (no network), so the
 * claim, replay, conflict, in-flight and ambiguity behaviors are verified at
 * the boundary the browser actually talks to.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

let sqliteAvailable = true;
try {
  await import('sqlite3');
  await import('sqlite');
} catch {
  sqliteAvailable = false;
}

const tmpDb = path.join(
  os.tmpdir(),
  `filtra-dot-http-idempotency-${Date.now()}-${process.pid}.sqlite`,
);

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.DOT_AGENT_WORKER_ENABLED = '0';
delete process.env.DOT_DEMO_MODE;
delete process.env.FILTRA_DOT_ENABLED;

const suite = sqliteAvailable ? describe : describe.skip;

const EMPRESA_A = `http-idem-a-${crypto.randomUUID()}`;
const EMPRESA_B = `http-idem-b-${crypto.randomUUID()}`;
const USER_A = crypto.randomUUID();
const USER_B = crypto.randomUUID();

let providerCalls = 0;
let providerGate: Promise<void> | null = null;
let mode: 'ok' | 'ambiguous' = 'ok';

let server: any;
let baseUrl = '';
let db: any;
let tokenA = '';
let tokenB = '';

type CallOptions = {
  key?: string | null;
  token?: string;
  message?: string;
  sessionId?: string;
};

/** Requisições em voo: o `beforeEach` espera todas terminarem antes de limpar. */
let inFlight = 0;

async function callDot(options: CallOptions = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${options.token ?? tokenA}`,
    'X-Dot-Csrf': '1',
  };
  if (options.key) headers['X-Idempotency-Key'] = options.key;

  inFlight += 1;
  try {
    const res = await fetch(`${baseUrl}/api/dot/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: options.message ?? 'Resuma minha reputação agora',
        session_id: options.sessionId ?? `session-${crypto.randomUUID()}`,
      }),
    });
    const data = await res.json().catch(() => ({}));
    return {
      status: res.status,
      data,
      replayed: res.headers.get('idempotency-replayed'),
      retryAfter: res.headers.get('retry-after'),
    };
  } finally {
    inFlight -= 1;
  }
}

// Janela generosa: o CI roda a suíte inteira em um runner compartilhado e a
// primeira chamada paga JWT, gate de plano, contexto e reserva no banco.
async function waitFor(predicate: () => boolean, timeoutMs = 30_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timeout esperando condição');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function reservations(empresaId: string) {
  return db.all(
    `SELECT id, status, ambiguous, ai_usage_id
       FROM dot_budget_reservations WHERE empresa_id = ? ORDER BY id`,
    [empresaId],
  );
}

async function createTenant(empresaId: string, userId: string, plan = 'rei') {
  const now = new Date().toISOString();
  const expira = new Date(Date.now() + 30 * 86_400_000).toISOString();
  await db.run(
    'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
    [empresaId, `cnpj${empresaId.replace(/\D/g, '').slice(0, 10)}`, 'Empresa Idem', `slug-${empresaId.slice(-8)}`, 'ativo', plan, now, expira],
  );
  await db.run(
    'INSERT INTO usuarios (id,cnpj,nome_funcionario,empresa_id,senha_hash) VALUES (?,?,?,?,?)',
    [userId, '00000000000000', 'Dono Idem', empresaId, 'x'],
  );
  const ownership: any = await import('../lib/empresaOwnership.js');
  await ownership.provisionEmpresaOwner(empresaId, userId, { source: 'signup' });
}

suite('Dot HTTP idempotency — contrato de borda', () => {
  before(async () => {
    const { initDB, getDb } = await import('../lib/db.js');
    await initDB();
    db = getDb();
    await db.run('DELETE FROM dot_http_idempotency').catch(() => undefined);

    const groq: any = await import('../groqService.js');
    groq.setCallAIImpl(async () => {
      providerCalls += 1;
      if (providerGate) await providerGate;
      if (mode === 'ambiguous') throw new Error('socket hang up');
      return {
        text: 'Resposta simulada do Dot.',
        provider: 'groq',
        latency_ms: 12,
        tokens: 640,
        model: 'sim-1',
        input_tokens: 120,
        output_tokens: 520,
      };
    });

    const express = (await import('express')).default;
    const { mountDotRoutes } = await import('../routes/dotRoutes.js');
    const app = express();
    app.use(express.json({ limit: '64kb' }));
    mountDotRoutes(app);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(Number(err?.status) || 500).json({ error: String(err?.message || 'erro') });
    });

    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    await createTenant(EMPRESA_A, USER_A);
    await createTenant(EMPRESA_B, USER_B);

    const jwtKeys: any = await import('../lib/jwtKeys.js');
    tokenA = jwtKeys.signAccessToken({ id: USER_A, nome_funcionario: 'Dono A', empresa_id: EMPRESA_A, role: 'empresa' });
    tokenB = jwtKeys.signAccessToken({ id: USER_B, nome_funcionario: 'Dono B', empresa_id: EMPRESA_B, role: 'empresa' });
  });

  after(async () => {
    server?.close();
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

  beforeEach(async () => {
    mode = 'ok';
    providerCalls = 0;
    providerGate = null;
    // Nenhuma requisição do teste anterior pode ficar em voo: ela escreveria
    // reservas/consumo depois da limpeza e corromperia a próxima asserção.
    await waitFor(() => inFlight === 0);
    await db.run('DELETE FROM dot_http_idempotency').catch(() => undefined);
    await db.run('DELETE FROM dot_budget_reservations WHERE empresa_id IN (?,?)', [EMPRESA_A, EMPRESA_B]);
    await db.run('DELETE FROM ai_usage WHERE empresa_id IN (?,?)', [EMPRESA_A, EMPRESA_B]);
    await db.run('DELETE FROM dot_response_cache WHERE empresa_id IN (?,?)', [EMPRESA_A, EMPRESA_B]).catch(() => undefined);
  });

  test('produção sem chave: 400 antes de reserva, cache ou provedor', async () => {
    const previousEnv = process.env.NODE_ENV;
    const previousFlag = process.env.FILTRA_DOT_ENABLED;
    process.env.NODE_ENV = 'production';
    process.env.FILTRA_DOT_ENABLED = '1';
    try {
      const response = await callDot({ key: null });
      assert.equal(response.status, 400);
      assert.equal(response.data.code, 'DOT_IDEMPOTENCY_KEY_REQUIRED');
      assert.equal(providerCalls, 0);
      assert.equal((await reservations(EMPRESA_A)).length, 0);
    } finally {
      process.env.NODE_ENV = previousEnv;
      if (previousFlag === undefined) delete process.env.FILTRA_DOT_ENABLED;
      else process.env.FILTRA_DOT_ENABLED = previousFlag;
    }
  });

  test('chave malformada: 400 sem efeito colateral', async () => {
    const response = await callDot({ key: 'curta' });
    assert.equal(response.status, 400);
    assert.equal(response.data.code, 'DOT_IDEMPOTENCY_KEY_INVALID');
    assert.equal(providerCalls, 0);
    assert.equal((await reservations(EMPRESA_A)).length, 0);
  });

  test('retry após sucesso replica status/JSON, uma única reserva e um único consumo', async () => {
    const key = `http-idem-replay-${crypto.randomUUID()}`;
    const message = 'Resuma a reputação da empresa';
    const sessionId = 'replay-session';

    const first = await callDot({ key, message, sessionId });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(providerCalls, 1);

    const second = await callDot({ key, message, sessionId });
    assert.equal(second.status, 200);
    assert.equal(second.replayed, 'true');
    assert.deepEqual(second.data, first.data);
    assert.equal(providerCalls, 1, 'replay não pode chamar o provedor');

    const rows = await reservations(EMPRESA_A);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'settled');
    const usage = await db.get(
      'SELECT COUNT(*) AS c FROM ai_usage WHERE empresa_id = ? AND feature = ?',
      [EMPRESA_A, 'dot'],
    );
    assert.equal(Number(usage.c), 1);
  });

  test('duas chamadas concorrentes com a mesma chave: uma executa e as demais recebem 409', async () => {
    const key = `http-idem-race-${crypto.randomUUID()}`;
    const message = 'Pergunta concorrente';
    const sessionId = 'race-session';

    let release!: () => void;
    providerGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pending = Array.from({ length: 6 }, () =>
      callDot({ key, message, sessionId }),
    );
    try {
      await waitFor(() => providerCalls === 1);
    } finally {
      // Liberar o portão mesmo em falha: uma requisição presa quebraria os
      // testes seguintes (o `beforeEach` apaga as reservas).
      release();
    }
    const results = await Promise.all(pending);
    providerGate = null;

    const ok = results.filter((r) => r.status === 200);
    const busy = results.filter((r) => r.status === 409);
    assert.equal(ok.length, 1, JSON.stringify(results.map((r) => [r.status, r.data.code])));
    assert.equal(busy.length, 5);
    for (const response of busy) {
      assert.equal(response.data.code, 'DOT_REQUEST_IN_PROGRESS');
      assert.ok(response.retryAfter, 'Retry-After deve orientar o cliente');
    }
    assert.equal(providerCalls, 1);
    assert.equal((await reservations(EMPRESA_A)).length, 1);
  });

  test('mesma chave com payload diferente: 409 sem segunda chamada ao provedor', async () => {
    const key = `http-idem-reuse-${crypto.randomUUID()}`;
    const first = await callDot({ key, message: 'Pergunta original', sessionId: 'reuse-1' });
    assert.equal(first.status, 200);
    assert.equal(providerCalls, 1);

    const reused = await callDot({ key, message: 'Pergunta diferente', sessionId: 'reuse-1' });
    assert.equal(reused.status, 409);
    assert.equal(reused.data.code, 'DOT_IDEMPOTENCY_KEY_REUSED');
    assert.equal(providerCalls, 1);
    assert.equal((await reservations(EMPRESA_A)).length, 1);
  });

  test('resultado ambíguo bloqueia o retry com a mesma chave (409 DOT_REQUEST_AMBIGUOUS)', async () => {
    mode = 'ambiguous';
    const key = `http-idem-ambiguous-${crypto.randomUUID()}`;

    const first = await callDot({ key, message: 'Analise a queda', sessionId: 'amb-1' });
    assert.equal(first.status, 503);
    assert.equal(providerCalls, 1);

    const retry = await callDot({ key, message: 'Analise a queda', sessionId: 'amb-1' });
    assert.equal(retry.status, 409);
    assert.equal(retry.data.code, 'DOT_REQUEST_AMBIGUOUS');
    assert.equal(providerCalls, 1, 'estado ambíguo NUNCA pode repetir o provedor');

    const rows = await reservations(EMPRESA_A);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
    assert.equal(Number(rows[0].ambiguous), 1);
  });

  test('isolamento multi-tenant: a mesma chave em empresas diferentes não colide', async () => {
    const key = `http-idem-multi-${crypto.randomUUID()}`;
    const message = 'Pergunta compartilhada';
    const sessionId = 'multi-session';

    const first = await callDot({ key, message, sessionId, token: tokenA });
    const second = await callDot({ key, message, sessionId, token: tokenB });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(providerCalls, 2);
    assert.equal((await reservations(EMPRESA_A)).length, 1);
    assert.equal((await reservations(EMPRESA_B)).length, 1);

    // Replay continua isolado por tenant.
    const replayA = await callDot({ key, message, sessionId, token: tokenA });
    const replayB = await callDot({ key, message, sessionId, token: tokenB });
    assert.equal(replayA.replayed, 'true');
    assert.equal(replayB.replayed, 'true');
    assert.deepEqual(replayA.data, first.data);
    assert.deepEqual(replayB.data, second.data);
    assert.equal(providerCalls, 2);
  });

  test('sem chave fora de produção o fluxo legado continua funcionando', async () => {
    const response = await callDot({ key: null, message: 'Mensagem sem chave', sessionId: 'no-key' });
    assert.equal(response.status, 200);
    assert.equal(providerCalls, 1);
  });
});
