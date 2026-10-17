/**
 * POST /api/lead (consentimento) e POST /api/legal/aceite.
 * Banco temporário isolado. Não depende de DNS: o caminho de sucesso do trial
 * (que valida MX) é coberto em integration.trial.test.ts.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';

const tmpDb = path.join(os.tmpdir(), `filtra-lead-test-${Date.now()}.sqlite`);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.APP_URL = 'http://localhost:3000';
process.env.ADMIN_EMAIL = 'admin-test@example.com';
process.env.ADMIN_PASSWORD = 'AdminTest@123';

let server: any;
let baseUrl = '';
let getDb: () => any;

before(async () => {
  const { default: express } = await import('express');
  const db = await import('../lib/db.js');
  getDb = db.getDb;
  const { mountLeadRoutes } = await import('../routes/leadRoutes.js');
  const { mountLegalAcceptRoutes } = await import('../routes/legalAcceptRoutes.js');
  const { notFoundHandler, errorHandler } = await import('../middleware/errorHandler.js');
  await db.initDB();
  const e = express();
  e.use(express.json({ limit: '20kb' }));
  mountLeadRoutes(e);
  mountLegalAcceptRoutes(e);
  e.use(notFoundHandler);
  e.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = e.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  try { fs.unlinkSync(tmpDb); } catch { /* ok */ }
});

async function post(p: string, body: unknown) {
  const res = await fetch(`${baseUrl}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const validLead = { nome_empresa: 'Padaria Teste', email: 'dono@padaria-teste.com.br', senha: 'Senha@12xyz', consent: true };

describe('POST /api/lead', () => {
  it('rejeita quando o consentimento está ausente', async () => {
    const { consent: _c, ...semConsent } = validLead;
    const { status, data } = await post('/api/lead', semConsent);
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  it('rejeita consent=false', async () => {
    const { status } = await post('/api/lead', { ...validLead, consent: false });
    assert.equal(status, 400);
  });

  it('rejeita e-mail inválido', async () => {
    const { status } = await post('/api/lead', { ...validLead, email: 'nao-e-email' });
    assert.equal(status, 400);
  });
});

describe('recordLeadConsent', () => {
  it('acrescenta prova de consentimento ao lead do trial sem apagar o conteúdo existente', async () => {
    const { recordLeadConsent } = await import('../routes/leadRoutes.js');
    const db = getDb();
    await db.exec(`CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, nome_empresa TEXT, email TEXT, telefone TEXT, fonte TEXT, maps_url TEXT, raw_json TEXT, criado_em TIMESTAMPTZ NOT NULL)`);
    await db.run(
      `INSERT INTO leads (id, nome_empresa, email, fonte, raw_json, criado_em) VALUES (?,?,?,?,?,?)`,
      ['l1', 'X', 'a@b.com', 'trial', JSON.stringify({ empresa_id: 'e1', slug: 's' }), new Date().toISOString()]
    );
    await recordLeadConsent('A@B.com', 'landing');
    const row = await db.get(`SELECT raw_json FROM leads WHERE id = 'l1'`);
    const raw = JSON.parse(row.raw_json);
    assert.equal(raw.empresa_id, 'e1');
    assert.equal(raw.consent, true);
    assert.equal(raw.source, 'landing');
    assert.ok(raw.consent_at);
  });

  it('não falha quando não existe lead para o e-mail', async () => {
    const { recordLeadConsent } = await import('../routes/leadRoutes.js');
    await assert.doesNotReject(recordLeadConsent('ninguem@x.com', 'site'));
  });
});

describe('POST /api/legal/aceite', () => {
  it('exige aceito=true', async () => {
    const { status } = await post('/api/legal/aceite', { plano: 'pro' });
    assert.equal(status, 400);
  });

  it('registra o aceite e devolve as versões', async () => {
    const { status, data } = await post('/api/legal/aceite', {
      aceito: true, contexto: 'trial', email: 'Dono@Teste.com', plano: 'pro',
    });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.ok(data.versao_termos);
    const row = await getDb().get(`SELECT action, actor_user_id FROM audit_logs WHERE action = 'legal.aceite_trial' ORDER BY id DESC LIMIT 1`);
    assert.equal(row?.action, 'legal.aceite_trial');
    assert.equal(row?.actor_user_id, 'dono@teste.com');
  });
});
