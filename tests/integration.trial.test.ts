/**
 * Testes de integração HTTP — trial + health.
 * Usa banco temporário isolado (não toca no database.sqlite de dev).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(os.tmpdir(), `filtra-test-${Date.now()}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.APP_URL = 'http://localhost:3000';
process.env.ADMIN_EMAIL = 'admin-test@example.com';
process.env.ADMIN_PASSWORD = 'AdminTest@123';

let app: any;
let server: any;
let baseUrl = '';

before(async () => {
  // Import dinâmico depois de setar env
  const { default: express } = await import('express');
  const cors = (await import('cors')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const { initDB } = await import('../lib/db.js');
  const { mountTrialRoutes } = await import('../routes/trialRoutes.js');
  const { mountReviewRoutes } = await import('../routes/reviewRoutes.js');
  const { notFoundHandler, errorHandler } = await import('../middleware/errorHandler.js');

  await initDB();

  const e = express();
  e.use(cookieParser());
  e.use(express.json({ limit: '20kb' }));
  e.use(cors({ origin: true, credentials: true }));
  e.get('/api/health', (_req, res) => res.json({ ok: true }));
  mountTrialRoutes(e);
  mountReviewRoutes(e);
  e.use(notFoundHandler);
  e.use(errorHandler);

  app = e;
  await new Promise<void>((resolve) => {
    server = e.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  try {
    fs.unlinkSync(tmpDb);
  } catch {
    /* ok */
  }
});

async function post(pathName: string, body: unknown) {
  const res = await fetch(`${baseUrl}${pathName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

describe('GET /api/health', () => {
  it('responde ok', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
  });
});

describe('POST /api/trial/ativar', () => {
  it('rejeita body inválido (sem CNPJ)', async () => {
    const { status, data } = await post('/api/trial/ativar', {
      nome_empresa: 'Teste SA',
      email: 'a@b.com',
      senha: 'Senha@12x',
    });
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  it('rejeita CNPJ inválido', async () => {
    const { status, data } = await post('/api/trial/ativar', {
      cnpj: '11111111111111',
      nome_empresa: 'Teste SA',
      email: 'valido@teste.com',
      senha: 'Senha@12x',
    });
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  it('ativa trial com CNPJ válido', async () => {
    // 11.222.333/0001-81 é válido nos testes unitários de CNPJ
    const { status, data } = await post('/api/trial/ativar', {
      cnpj: '11222333000181',
      nome_empresa: 'Empresa Integração Teste',
      email: `trial-${Date.now()}@teste.com`,
      senha: 'Senha@12x',
    });
    assert.equal(status, 201);
    assert.equal(data.success, true);
    assert.ok(data.empresa_id);
    assert.ok(data.slug);
    assert.ok(String(data.link_acesso).includes('/avaliacao/'));
  });

  it('bloqueia CNPJ duplicado', async () => {
    const email = `dup-${Date.now()}@teste.com`;
    // usa outro CNPJ válido gerado com base diferente — se o anterior já ocupou 11222333000181,
    // este segundo request com o mesmo CNPJ deve ser 409
    const { status } = await post('/api/trial/ativar', {
      cnpj: '11222333000181',
      nome_empresa: 'Duplicada',
      email,
      senha: 'Senha@12x',
    });
    assert.equal(status, 409);
  });
});

describe('POST /api/reviews', () => {
  it('rejeita rating inválido', async () => {
    const { status, data } = await post('/api/reviews', {
      rating: 9,
      comment: 'x',
    });
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  it('exige comentário para nota ≤ 3', async () => {
    const { status, data } = await post('/api/reviews', {
      rating: 2,
      name: 'Cliente',
    });
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  it('aceita review 5 estrelas sem comentário', async () => {
    const { status, data } = await post('/api/reviews', {
      rating: 5,
      name: 'Cliente Feliz',
    });
    assert.equal(status, 201);
    assert.equal(data.success, true);
  });
});
