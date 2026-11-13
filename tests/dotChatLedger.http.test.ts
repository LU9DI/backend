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

async function callExplain(responseText: string, key: string) {
  const res = await fetch(`${baseUrl}/api/dot/explain`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
      'X-Dot-Csrf': '1',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({ response_text: responseText }),
  });
  const data = await res.json().catch(() => ({}));
  return {
    status: res.status,
    data,
    replayed: res.headers.get('Idempotency-Replayed') === 'true',
  };
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
    await db.run('DELETE FROM dot_http_idempotency WHERE empresa_id IN (?,?)', [EMPRESA, EMPRESA_VAZIA]).catch(() => undefined);
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

  test('produção com DOT desativado: explain retorna 404 sem reserva ou chamada ao provedor', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousEnabled = process.env.FILTRA_DOT_ENABLED;
    const callsBefore = providerCalls;
    try {
      process.env.NODE_ENV = 'production';
      process.env.FILTRA_DOT_ENABLED = '0';
      const response = await callExplain('Não deve ser processado com DOT desligado.', `explain-disabled-${crypto.randomUUID()}`);
      assert.equal(response.status, 404);
      assert.equal(response.data.code, 'DOT_DISABLED');
      assert.equal(providerCalls, callsBefore);
      assert.equal((await reservations(EMPRESA)).length, 0);
      assert.equal((await usageCount(EMPRESA)).rows, 0);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousEnabled === undefined) delete process.env.FILTRA_DOT_ENABLED;
      else process.env.FILTRA_DOT_ENABLED = previousEnabled;
    }
  });

  test('explain: mesma chave reproduz resposta sem segunda chamada nem débito', async () => {
    const key = `explain-replay-${crypto.randomUUID()}`;
    const beforeCalls = providerCalls;
    const first = await callExplain('A nota média permaneceu estável.', key);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.ok, true);
    assert.equal(providerCalls, beforeCalls + 1);

    const second = await callExplain('A nota média permaneceu estável.', key);
    assert.equal(second.status, 200, JSON.stringify(second.data));
    assert.equal(second.replayed, true);
    assert.deepEqual(second.data, first.data);
    assert.equal(providerCalls, beforeCalls + 1, 'replay não pode chamar o provedor novamente');

    const rows = await reservations(EMPRESA);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'settled');
    assert.equal((await usageCount(EMPRESA)).rows, 1);
  });

  test('explain: mesma chave com conteúdo diferente é recusada sem segunda chamada', async () => {
    const key = `explain-mismatch-${crypto.randomUUID()}`;
    const first = await callExplain('Explicação original.', key);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const callsAfterFirst = providerCalls;

    const changed = await callExplain('Conteúdo diferente.', key);
    assert.equal(changed.status, 409);
    assert.equal(changed.data.code, 'DOT_IDEMPOTENCY_KEY_REUSED');
    assert.equal(providerCalls, callsAfterFirst);
    assert.equal((await reservations(EMPRESA)).length, 1);
  });

  test('explain: duas requisições simultâneas com a mesma chave geram no máximo uma chamada', async () => {
    const key = `explain-race-${crypto.randomUUID()}`;
    const beforeCalls = providerCalls;
    const results = await Promise.all([
      callExplain('Explique evidências concorrentes.', key),
      callExplain('Explique evidências concorrentes.', key),
    ]);
    assert.equal(results.filter((item) => item.status === 200).length, 1, JSON.stringify(results));
    assert.equal(results.filter((item) => item.status === 409).length, 1, JSON.stringify(results));
    assert.equal(providerCalls, beforeCalls + 1);
    assert.equal((await reservations(EMPRESA)).length, 1);
    assert.equal((await usageCount(EMPRESA)).rows, 1);
  });

  test('explain: falha ao vincular reserva libera com segurança e permite retry', async () => {
    const key = `explain-link-failure-${crypto.randomUUID()}`;
    const callsBefore = providerCalls;
    await db.exec(`
      CREATE TRIGGER fail_explain_reservation_link
      BEFORE UPDATE OF reservation_id ON dot_http_idempotency
      WHEN NEW.endpoint = '/api/dot/explain' AND NEW.reservation_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'simulated reservation link failure');
      END;
    `);
    try {
      const response = await callExplain('Teste de falha de vínculo.', key);
      assert.equal(response.status, 503);
      assert.equal(response.data.code, 'DOT_IDEMPOTENCY_RESERVATION_LINK_FAILED');
      assert.equal(providerCalls, callsBefore, 'provedor não pode ser chamado sem vínculo durável');
      const rows = await reservations(EMPRESA);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'released');
      const state = await db.get(
        'SELECT status, reservation_id FROM dot_http_idempotency WHERE empresa_id = ? AND endpoint = ? AND idempotency_key = ?',
        [EMPRESA, '/api/dot/explain', key],
      );
      assert.equal(state.status, 'failed_safe');
      assert.equal(state.reservation_id, null);
    } finally {
      await db.exec('DROP TRIGGER IF EXISTS fail_explain_reservation_link');
    }
  });

  test('explain: falha ao marcar envio libera reserva e não chama provedor', async () => {
    const key = `explain-mark-failure-${crypto.randomUUID()}`;
    const callsBefore = providerCalls;
    await db.exec(`
      CREATE TRIGGER fail_explain_mark_sent
      BEFORE UPDATE OF sent_at ON dot_budget_reservations
      WHEN NEW.sent_at IS NOT NULL AND OLD.sent_at IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'simulated mark sent failure');
      END;
    `);
    try {
      const response = await callExplain('Teste de falha ao marcar envio.', key);
      assert.equal(response.status, 503);
      assert.equal(response.data.code, 'DOT_BUDGET_UNAVAILABLE');
      assert.equal(providerCalls, callsBefore, 'provedor não pode ser chamado quando a marcação falha');
      const rows = await reservations(EMPRESA);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'released');
      const state = await db.get(
        'SELECT status, reservation_id FROM dot_http_idempotency WHERE empresa_id = ? AND endpoint = ? AND idempotency_key = ?',
        [EMPRESA, '/api/dot/explain', key],
      );
      assert.equal(state.status, 'failed_safe');
      assert.equal(state.reservation_id, null);
    } finally {
      await db.exec('DROP TRIGGER IF EXISTS fail_explain_mark_sent');
    }
  });

  test('explain: recusa comprovada do provedor libera a chave para retry seguro', async () => {
    mode = 'rejected';
    const key = `explain-rejected-${crypto.randomUUID()}`;
    const beforeCalls = providerCalls;

    const first = await callExplain('Explique uma resposta recusada antes do processamento.', key);
    assert.equal(first.status, 503);
    assert.equal(providerCalls, beforeCalls + 1);
    let rows = await reservations(EMPRESA);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'released');
    let state = await db.get(
      'SELECT status FROM dot_http_idempotency WHERE empresa_id = ? AND endpoint = ? AND idempotency_key = ?',
      [EMPRESA, '/api/dot/explain', key],
    );
    assert.equal(state.status, 'failed_safe');

    // A mesma chave/hash pode tentar novamente porque o provedor informou
    // explicitamente que não processou a solicitação anterior.
    const retry = await callExplain('Explique uma resposta recusada antes do processamento.', key);
    assert.equal(retry.status, 503);
    assert.equal(retry.data.code, undefined);
    assert.equal(providerCalls, beforeCalls + 2);
    rows = await reservations(EMPRESA);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row: { status: string }) => row.status === 'released'));
    state = await db.get(
      'SELECT status FROM dot_http_idempotency WHERE empresa_id = ? AND endpoint = ? AND idempotency_key = ?',
      [EMPRESA, '/api/dot/explain', key],
    );
    assert.equal(state.status, 'failed_safe');
  });

  test('explain: resultado ambíguo bloqueia retry e não repete chamada ao provedor', async () => {
    mode = 'ambiguous';
    const key = `explain-ambiguous-${crypto.randomUUID()}`;
    const first = await callExplain('Explique uma resposta cujo provedor expira.', key);
    assert.equal(first.status, 503, JSON.stringify(first.data));
    const callsAfterFirst = providerCalls;

    const retry = await callExplain('Explique uma resposta cujo provedor expira.', key);
    assert.equal(retry.status, 409);
    assert.equal(retry.data.code, 'DOT_REQUEST_AMBIGUOUS');
    assert.equal(providerCalls, callsAfterFirst, 'tentativa ambígua nunca pode ser reenviada');
    const rows = await reservations(EMPRESA);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
    assert.equal(Number(rows[0].ambiguous), 1);
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
