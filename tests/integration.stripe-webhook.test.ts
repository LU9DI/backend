/**
 * E2E (integração): pagamento Stripe simulado → plano ativado.
 *
 * Fluxo:
 *  1. Cria empresa trial no SQLite temporário
 *  2. POST /api/webhook/stripe com checkout.session.completed (sem assinatura HMAC em test)
 *  3. Assert status=ativo, plan=pro, stripe_customer_id preenchido
 *
 * Não exige STRIPE_SECRET_KEY real — só a lógica de ativação pós-pagamento.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(os.tmpdir(), `filtra-stripe-e2e-${Date.now()}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.SQLITE_DB_PATH = tmpDb;
process.env.APP_URL = 'http://localhost:3000';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.ADMIN_EMAIL = 'admin-stripe-e2e@example.com';
process.env.ADMIN_PASSWORD = 'AdminTest@123';
// O webhook exige STRIPE_ENABLED + assinatura HMAC válida. Usamos um segredo
// efêmero gerado em runtime (fixture de teste, nunca uma credencial) e
// calculamos a assinatura localmente — sem chamadas externas nem chaves reais.
process.env.STRIPE_ENABLED = 'true';
const webhookSecret = crypto.randomBytes(24).toString('hex');
process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
delete process.env.DATABASE_URL;

let server: any;
let baseUrl = '';
let getDb: () => any;

before(async () => {
  const { default: express } = await import('express');
  const cookieParser = (await import('cookie-parser')).default;
  const dbMod = await import('../lib/db.js');
  const { mountStripeRoutes } = await import('../stripeRoutes.js');
  const { notFoundHandler, errorHandler } = await import('../middleware/errorHandler.js');

  await dbMod.initDB();
  getDb = dbMod.getDb;

  // empresa trial
  const empresaId = crypto.randomUUID();
  const agora = new Date();
  const expira = new Date(agora.getTime() + 7 * 24 * 60 * 60 * 1000);
  await getDb().run(
    `INSERT INTO empresas (id, cnpj, nome_empresa, slug, status, plan, criado_em, expira_em)
     VALUES (?, ?, ?, ?, 'trial', 'trial', ?, ?)`,
    [
      empresaId,
      '11222333000181',
      'Empresa Stripe E2E',
      `stripe-e2e-${Date.now()}`,
      agora.toISOString(),
      expira.toISOString(),
    ]
  );
  (global as any).__stripeE2EEmpresaId = empresaId;

  const e = express();
  e.use(cookieParser());
  // webhook precisa de raw body — mountStripeRoutes registra express.raw na rota
  e.use((req, res, next) => {
    if (req.originalUrl?.startsWith('/api/webhook/stripe')) return next();
    return express.json({ limit: '20kb' })(req, res, next);
  });

  mountStripeRoutes(e, getDb);
  e.use(notFoundHandler);
  e.use(errorHandler);

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
    /* */
  }
});

describe('E2E Stripe webhook → ativação de plano', () => {
  it('checkout.session.completed ativa plan=pro', async () => {
    const empresaId = (global as any).__stripeE2EEmpresaId as string;
    assert.ok(empresaId);

    const before = await getDb().get('SELECT * FROM empresas WHERE id = ?', [empresaId]);
    assert.equal(before.status, 'trial');

    const event = {
      id: `evt_test_${Date.now()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          object: 'checkout.session',
          id: `cs_test_${Date.now()}`,
          payment_status: 'paid',
          customer: 'cus_test_e2e',
          subscription: 'sub_test_e2e',
          client_reference_id: empresaId,
          metadata: {
            empresa_id: empresaId,
            plan_db: 'pro',
            plano: 'pro',
          },
        },
      },
    };

    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac('sha256', webhookSecret).update(`${t}.${body}`, 'utf8').digest('hex');
    const res = await fetch(`${baseUrl}/api/webhook/stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': `t=${t},v1=${signature}`,
      },
      body,
    });

    const data = await res.json().catch(() => ({}));
    assert.equal(res.status, 200, JSON.stringify(data));
    assert.equal(data.ok, true);
    assert.equal(data.action, 'activate');

    const after = await getDb().get('SELECT * FROM empresas WHERE id = ?', [empresaId]);
    assert.equal(after.status, 'ativo');
    assert.equal(after.plan, 'pro');
    assert.equal(after.stripe_customer_id, 'cus_test_e2e');
    assert.equal(after.stripe_subscription_id, 'sub_test_e2e');
  });

  it('GET /api/empresa/:id/assinatura reflete acesso pago', async () => {
    const empresaId = (global as any).__stripeE2EEmpresaId as string;
    const res = await fetch(`${baseUrl}/api/empresa/${empresaId}/assinatura`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ativo');
    assert.equal(data.plan, 'pro');
    assert.equal(data.tem_acesso, true);
  });
});
