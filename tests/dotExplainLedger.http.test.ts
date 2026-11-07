/**
 * `/api/dot/explain` com o ledger do orçamento — provedor simulado.
 *
 * Garantias exigidas pela auditoria:
 *  1. conta autenticada passa pelo MESMO ledger da conversa (reserva → envio →
 *     finalização com consumo real de entrada/saída);
 *  2. resultado ambíguo: 503, reserva ABERTA e orçamento comprometido;
 *  3. recusa do provedor: 503 e reserva LIBERADA;
 *  4. orçamento esgotado: 429 com código DOT_TOKEN_LIMIT, sem reserva;
 *  5. modo demonstração: responde sem reservar e sem gravar consumo.
 *
 * Um único app Express é montado; `filtra.test.auth` é mutável por requisição
 * de teste (as rotas leem a identidade a cada request), o que evita depender
 * da ordem entre aplicações.
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

const tmpDb = path.join(os.tmpdir(), `filtra-dot-explain-${Date.now()}-${process.pid}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.DOT_AGENT_WORKER_ENABLED = '0';
// Demo via DOT_DEMO_MODE (sem token); os demais casos usam JWT real.
process.env.DOT_DEMO_MODE = '1';

const suite = sqliteAvailable ? describe : describe.skip;

const EMPRESA = `explain-rei-${crypto.randomUUID()}`;
const EMPRESA_EXAUSTA = `explain-empty-${crypto.randomUUID()}`;
const EMPRESA_DEMO = `explain-demo-${crypto.randomUUID()}`;
const USER_ID = crypto.randomUUID();

type Mode = 'ok' | 'ambiguous' | 'rejected' | 'rate_limited';
type TestAuth = { empresaId: string; plan: string; userId: string | null; demo?: boolean };
let mode: Mode = 'ok';
let providerCalls = 0;

let app: any;
let server: any;
let baseUrl = '';
let db: any;
let ledger: typeof import('../services/dotLedger.js');
let tokenEmpresa = '';
let tokenExausta = '';

const AUTH_EMPRESA: TestAuth = { empresaId: EMPRESA, plan: 'rei', userId: USER_ID };
const AUTH_EXAUSTA: TestAuth = { empresaId: EMPRESA_EXAUSTA, plan: 'rei', userId: USER_ID };
const AUTH_DEMO: TestAuth = { empresaId: EMPRESA_DEMO, plan: 'trial', userId: null, demo: true };

async function postExplain(responseText = 'Resposta qualquer para explicar.', token: string = tokenEmpresa) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Dot-Csrf': '1' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}/api/dot/explain`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ response_text: responseText }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function usage(empresaId: string) {
  const row = await db.get(
    'SELECT COUNT(*) AS c, COALESCE(SUM(tokens),0) AS t FROM ai_usage WHERE empresa_id = ? AND feature = ?',
    [empresaId, 'dot'],
  );
  return { rows: Number(row.c), tokens: Number(row.t) };
}

async function reservations(empresaId: string) {
  return db.all(
    'SELECT id, status, tokens_reserved, tokens_real, ambiguous, ai_usage_id FROM dot_budget_reservations WHERE empresa_id = ? ORDER BY id',
    [empresaId],
  );
}

suite('Dot /api/dot/explain + ledger (provedor simulado)', () => {
  before(async () => {
    const { initDB, getDb } = await import('../lib/db.js');
    await initDB();
    db = getDb();
    ledger = await import('../services/dotLedger.js');
    await ledger.ensureDotLedgerSchema();

    const groq: any = await import('../groqService.js');
    groq.setCallAIImpl(async (_system: string, _user: string, _maxTokens: number) => {
      providerCalls += 1;
      if (mode === 'ok') {
        return {
          text: 'Explicação simulada.',
          provider: 'groq',
          latency_ms: 9,
          tokens: 440,
          model: 'sim-explain',
          input_tokens: 100,
          output_tokens: 340,
        };
      }
      if (mode === 'rejected') {
        const error: any = new Error('Groq API error 429: rate limit; request not processed');
        error.status = 429;
        throw error;
      }
      if (mode === 'rate_limited') {
        const error: any = new Error('Groq API error 429: rate limit');
        error.status = 429;
        throw error;
      }
      throw new Error('socket hang up');
    });

    const express = (await import('express')).default;
    const { mountDotRoutes } = await import('../routes/dotRoutes.js');
    app = express();
    app.use(express.json({ limit: '64kb' }));
    mountDotRoutes(app);
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const now = new Date().toISOString();
    const expira = new Date(Date.now() + 30 * 86_400_000).toISOString();
    for (const id of [EMPRESA, EMPRESA_EXAUSTA, EMPRESA_DEMO]) {
      await db.run(
        'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
        [id, `cnpj${id.replace(/\D/g, '').slice(0, 10)}`, 'Empresa Explain', `slug-${id.slice(-8)}`, 'ativo', 'rei', now, expira],
      );
    }

    // JWT real: o gancho de teste foi removido da rota.
    await db.run(
      'INSERT INTO usuarios (id,cnpj,nome_funcionario,empresa_id,senha_hash) VALUES (?,?,?,?,?)',
      [USER_ID, '00000000000000', 'Dono Explain', EMPRESA, 'x'],
    );
    const ownership: any = await import('../lib/empresaOwnership.js');
    await ownership.provisionEmpresaOwner(EMPRESA, USER_ID, { source: 'signup' });
    const jwtKeys: any = await import('../lib/jwtKeys.js');
    tokenEmpresa = jwtKeys.signAccessToken({ id: USER_ID, nome_funcionario: 'Dono Explain', empresa_id: EMPRESA, role: 'empresa' });
    tokenExausta = jwtKeys.signAccessToken({ id: USER_ID, nome_funcionario: 'Dono Explain', empresa_id: EMPRESA_EXAUSTA, role: 'empresa' });
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
    await db.run('DELETE FROM dot_budget_reservations WHERE empresa_id IN (?,?,?)', [EMPRESA, EMPRESA_EXAUSTA, EMPRESA_DEMO]);
    await db.run('DELETE FROM ai_usage WHERE empresa_id IN (?,?,?)', [EMPRESA, EMPRESA_EXAUSTA, EMPRESA_DEMO]);
  });

  test('autenticado: 200, reserva liquidada e consumo real (in/out) registrado', async () => {
    const response = await postExplain();
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.ok, true);

    const rows = await reservations(EMPRESA);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'settled');
    assert.ok(rows[0].ai_usage_id);
    const usageRow = await db.get(
      'SELECT tokens, tokens_input, tokens_output FROM ai_usage WHERE empresa_id = ? AND feature = ?',
      [EMPRESA, 'dot'],
    );
    assert.equal(Number(usageRow.tokens), 440);
    assert.equal(Number(usageRow.tokens_input), 100);
    assert.equal(Number(usageRow.tokens_output), 340);
    assert.equal((await usage(EMPRESA)).rows, 1);
  });

  test('resultado ambíguo: 503, reserva aberta e orçamento comprometido', async () => {
    mode = 'ambiguous';
    const response = await postExplain();
    assert.equal(response.status, 503);

    const rows = await reservations(EMPRESA);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
    assert.equal(Number(rows[0].ambiguous), 1);
    assert.equal((await usage(EMPRESA)).rows, 0);

    const snapshot = await ledger.getDotBudgetSnapshot(EMPRESA, 'rei');
    assert.ok(snapshot.ambiguous > 0);
  });

  test('recusa estruturada COM evidência: 503 e reserva liberada — nada debitado', async () => {
    mode = 'rejected';
    const response = await postExplain();
    assert.equal(response.status, 503);

    const rows = await reservations(EMPRESA);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'released');
    assert.equal((await usage(EMPRESA)).rows, 0);
  });

  test('429 SEM evidência: AMBÍGUO, reserva aberta e nada debitado', async () => {
    mode = 'rate_limited';
    const response = await postExplain();
    assert.equal(response.status, 503);

    const rows = await reservations(EMPRESA);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending', '429 sem prova NÃO pode liberar orçamento');
    assert.equal(Number(rows[0].ambiguous), 1);
    assert.equal((await usage(EMPRESA)).rows, 0);
  });

  test('orçamento esgotado: 429 com DOT_TOKEN_LIMIT e nenhuma reserva criada', async () => {
    await db.run(
      "INSERT INTO ai_usage (empresa_id, tipo, tokens, provider, feature, criado_em) VALUES (?,?,?,?,?,datetime('now'))",
      [EMPRESA_EXAUSTA, 'filtra_dot_chat', 599_900, 'groq', 'dot'],
    );
    const response = await postExplain(undefined, tokenExausta);
    assert.equal(response.status, 429, JSON.stringify(response.data));
    assert.equal(response.data.code, 'DOT_TOKEN_LIMIT');
    assert.equal((await reservations(EMPRESA_EXAUSTA)).length, 0, 'reserva recusada não pode deixar linha aberta');
  });

  test('demonstração: 200 sem reserva e sem consumo gravado', async () => {
    const response = await postExplain(undefined, '');
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.demo, true);

    assert.equal((await reservations(EMPRESA_DEMO)).length, 0);
    assert.equal((await usage(EMPRESA_DEMO)).rows, 0);
  });
});
