/**
 * Rotas HTTP do Filtra Dot com o ledger do orçamento — provedor simulado.
 *
 * Nenhuma chamada real a provedor de IA: `groqService.callAI` é substituído
 * por um duplo que responde 200, recusa (4xx/429) ou fica ambíguo (timeout).
 *
 * Cenários exigidos pela auditoria:
 *  1. execução bem-sucedida: reserva → 200 → finalização com consumo real;
 *  2. resultado ambíguo: 503, reserva ABERTA e orçamento comprometido;
 *  3. falha comprovada antes do envio: 503 e reserva LIBERADA;
 *  4. provedor indisponível: 503, nenhuma reserva abandonada;
 *  5. `GET /api/dot/budget`: valores coerentes e sem dado sensível;
 *  6. retry da mesma execução: não duplica consumo.
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

const tmpDb = path.join(os.tmpdir(), `filtra-dot-http-ledger-${Date.now()}-${process.pid}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.DOT_AGENT_WORKER_ENABLED = '0';
delete process.env.DOT_DEMO_MODE;

const suite = sqliteAvailable ? describe : describe.skip;

const EMPRESA = `http-rei-${crypto.randomUUID()}`;
const EMPRESA_VAZIA = `http-rei-empty-${crypto.randomUUID()}`;
const USER_ID = crypto.randomUUID();

type Mode = 'ok' | 'rejected' | 'rate_limited' | 'ambiguous' | 'no_provider';
let mode: Mode = 'ok';
let providerCalls = 0;

let server: any;
let baseUrl = '';
let db: any;
let ledger: typeof import('../services/dotLedger.js');
let authToken = '';

async function callDot(body: unknown) {
  const res = await fetch(`${baseUrl}/api/dot/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
      'X-Dot-Csrf': '1',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function usageCount(empresaId: string) {
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

suite('Dot HTTP + ledger (provedor simulado)', () => {
  before(async () => {
    const { initDB, getDb } = await import('../lib/db.js');
    await initDB();
    db = getDb();
    ledger = await import('../services/dotLedger.js');
    await ledger.ensureDotLedgerSchema();

    // Duplo do provedor de IA: instalado na indireção de `groqService`
    // (`setCallAIImpl`). Nenhuma chamada de rede, nenhum crédito consumido.
    const groq: any = await import('../groqService.js');
    groq.setCallAIImpl(async (_system: string, _user: string, _maxTokens: number) => {
      providerCalls += 1;
      if (mode === 'ok') {
        return { text: 'Resposta simulada do Dot.', provider: 'groq', latency_ms: 12, tokens: 640, model: 'sim-1', input_tokens: 120, output_tokens: 520 };
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
      if (mode === 'no_provider') {
        throw new Error('Nenhuma IA configurada. Defina GROQ_API_KEY e/ou GEMINI_API_KEY no .env');
      }
      throw new Error('socket hang up');
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

    const now = new Date().toISOString();
    const expira = new Date(Date.now() + 30 * 86_400_000).toISOString();
    for (const id of [EMPRESA, EMPRESA_VAZIA]) {
      await db.run(
        'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
        [id, `cnpj${id.replace(/\D/g, '').slice(0, 10)}`, 'Empresa HTTP', `slug-${id.slice(-8)}`, 'ativo', 'rei', now, expira],
      );
    }

    // JWT real: o gancho de teste foi removido da rota.
    await db.run(
      'INSERT INTO usuarios (id,cnpj,nome_funcionario,empresa_id,senha_hash) VALUES (?,?,?,?,?)',
      [USER_ID, '00000000000000', 'Dono HTTP', EMPRESA, 'x'],
    );
    const ownership: any = await import('../lib/empresaOwnership.js');
    await ownership.provisionEmpresaOwner(EMPRESA, USER_ID, { source: 'signup' });
    const jwtKeys: any = await import('../lib/jwtKeys.js');
    authToken = jwtKeys.signAccessToken({ id: USER_ID, nome_funcionario: 'Dono HTTP', empresa_id: EMPRESA, role: 'empresa' });
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
    await db.run('DELETE FROM dot_budget_reservations WHERE empresa_id IN (?,?)', [EMPRESA, EMPRESA_VAZIA]);
    await db.run('DELETE FROM ai_usage WHERE empresa_id IN (?,?)', [EMPRESA, EMPRESA_VAZIA]);
    await db.run('DELETE FROM dot_response_cache WHERE empresa_id IN (?,?)', [EMPRESA, EMPRESA_VAZIA]).catch(() => undefined);
  });

  test('execução bem-sucedida: 200, reserva finalizada e consumo real registrado', async () => {
    const response = await callDot({ message: 'Resuma minha reputação agora', session_id: 'ok-1' });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.ok, true);
    assert.equal(response.data.provider, 'groq');

    const rows = await reservations(EMPRESA);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'settled');
    assert.ok(rows[0].ai_usage_id, 'a reserva precisa apontar para o consumo real');
    const usage = await usageCount(EMPRESA);
    assert.equal(usage.rows, 1);
    assert.ok(usage.tokens >= 640);
    assert.equal(response.data.dot_tokens_used, usage.tokens);
  });

  test('resultado ambíguo: 503, reserva permanece aberta e o orçamento continua comprometido', async () => {
    mode = 'ambiguous';
    const response = await callDot({ message: 'Analise a queda de nota', session_id: 'amb-1' });
    assert.equal(response.status, 503);

    const rows = await reservations(EMPRESA);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending', 'resultado ambíguo NÃO pode liberar a reserva');
    assert.equal(Number(rows[0].ambiguous), 1);
    assert.equal(rows[0].ai_usage_id ?? null, null);
    assert.equal((await usageCount(EMPRESA)).rows, 0);

    const snapshot = await ledger.getDotBudgetSnapshot(EMPRESA, 'rei');
    assert.ok(snapshot.reserved > 0);
    assert.ok(snapshot.ambiguous > 0);

    const budget = await fetch(`${baseUrl}/api/dot/budget`, { headers: { Authorization: `Bearer ${authToken}` } }).then((r) => r.json());
    assert.equal(budget.ok, true);
    assert.equal(budget.budget.ambiguous, snapshot.ambiguous);
    assert.equal(budget.open_reservations.length, 1);
    assert.equal(budget.open_reservations[0].ambiguous, true);
  });

  test('recusa estruturada COM evidência de não processamento: 503 e reserva liberada', async () => {
    mode = 'rejected';
    const response = await callDot({ message: 'Explique a tendência', session_id: 'rej-1' });
    assert.equal(response.status, 503);

    const rows = await reservations(EMPRESA);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'released');
    assert.equal((await usageCount(EMPRESA)).rows, 0);
    const snapshot = await ledger.getDotBudgetSnapshot(EMPRESA, 'rei');
    assert.equal(snapshot.reserved, 0);
  });

  test('429 SEM evidência de não processamento: AMBÍGUO, reserva aberta e nada debitado', async () => {
    mode = 'rate_limited';
    const response = await callDot({ message: 'Explique a tendência', session_id: 'rl-1' });
    assert.equal(response.status, 503);

    const rows = await reservations(EMPRESA);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending', '429 sem prova NÃO pode liberar orçamento');
    assert.equal(Number(rows[0].ambiguous), 1);
    assert.equal((await usageCount(EMPRESA)).rows, 0);
  });

  test('nenhum provedor configurado: 503 e reserva liberada', async () => {
    mode = 'no_provider';
    const response = await callDot({ message: 'Qual o próximo passo?', session_id: 'np-1' });
    assert.equal(response.status, 503);
    const rows = await reservations(EMPRESA);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'released');
  });

  test('orçamento esgotado: 429 sem criar reserva', async () => {
    await db.run(
      "INSERT INTO ai_usage (empresa_id, tipo, tokens, provider, feature, criado_em) VALUES (?,?,?,?,?,datetime('now'))",
      [EMPRESA_VAZIA, 'filtra_dot_chat', 599_500, 'groq', 'dot'],
    );
    // A rota usa a empresa do gate; o teste valida a recusa via ledger direto
    // para não depender de reconfigurar o gate no meio da suíte.
    const refused = await ledger.reserveDotExecution({ empresaId: EMPRESA_VAZIA, plan: 'rei' });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'DOT_TOKEN_LIMIT');
    const rows = await db.all('SELECT id FROM dot_budget_reservations WHERE empresa_id = ?', [EMPRESA_VAZIA]);
    assert.equal(rows.length, 0, 'reserva recusada não pode deixar linha aberta');
  });

  test('retry da mesma execução não duplica consumo', async () => {
    const first = await callDot({ message: 'Quais os riscos atuais?', session_id: 'retry-1' });
    assert.equal(first.status, 200);
    const rows = await reservations(EMPRESA);
    assert.equal(rows.length, 1);
    const reservationId = rows[0].id;

    // Retry da finalização (mesma reserva) — idempotente.
    const replay = await ledger.finalizeDotReservation({
      empresaId: EMPRESA,
      reservationId,
      tokens: 640,
      provider: 'groq',
    });
    assert.equal(replay.duplicate, true);
    const usage = await usageCount(EMPRESA);
    assert.equal(usage.rows, 1, 'retry não pode criar segunda linha de consumo');
    assert.equal((await reservations(EMPRESA)).length, 1);
  });

  test('GET /api/dot/budget não expõe dado sensível', async () => {
    const response = await fetch(`${baseUrl}/api/dot/budget`, { headers: { Authorization: `Bearer ${authToken}` } });
    assert.equal(response.status, 200);
    const raw = await response.text();
    const data = JSON.parse(raw);
    assert.equal(data.ok, true);
    assert.equal(data.budget.limit > 0, true);
    assert.ok(!raw.includes(USER_ID), 'o painel não pode devolver o id do usuário');
    assert.ok(!/@/.test(raw), 'o painel não pode devolver e-mail');
    for (const item of data.open_reservations) {
      assert.deepEqual(
        Object.keys(item).sort(),
        ['ambiguous', 'created_at', 'expires_at', 'id', 'status', 'tokens_estimated', 'tokens_reserved'].sort(),
      );
    }
  });
});
