import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  validateBody,
  schemaTrialAtivar,
  schemaReview,
  schemaLoginEmpresa,
  schemaCheckout,
  ensureLoginIdentifier,
} from '../middleware/validate.js';

function mockRes() {
  const res: any = {};
  res.statusCode = 200;
  res.body = null;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data: unknown) => {
    res.body = data;
    return res;
  };
  return res as Response & { statusCode: number; body: any };
}

function run(schema: Parameters<typeof validateBody>[0], body: unknown) {
  const req = { body } as Request;
  const res = mockRes();
  let nextCalled = false;
  validateBody(schema)(req, res, () => {
    nextCalled = true;
  });
  return { req, res, nextCalled };
}

describe('validateBody + schemaTrialAtivar', () => {
  it('rejeita body vazio', () => {
    const { res, nextCalled } = run(schemaTrialAtivar, {});
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.fields);
  });

  it('rejeita CNPJ inválido', () => {
    const { res, nextCalled } = run(schemaTrialAtivar, {
      cnpj: '11111111111111',
      nome_empresa: 'Loja Teste',
      email: 'a@b.com',
      senha: 'Senha@12',
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.ok(String(res.body.error).toLowerCase().includes('cnpj'));
  });

  it('aceita payload válido', () => {
    const { res, nextCalled, req } = run(schemaTrialAtivar, {
      cnpj: '11.222.333/0001-81',
      nome_empresa: 'Loja Teste',
      email: 'Dono@Email.COM',
      senha: 'Senha@12',
    });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(req.body.cnpj, '11222333000181');
    assert.equal(req.body.email, 'dono@email.com');
  });
});

describe('schemaReview', () => {
  it('exige comentário em nota baixa', () => {
    const { res, nextCalled } = run(schemaReview, { rating: 2, comment: '' });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
  });

  it('aceita nota alta sem comentário', () => {
    const { nextCalled } = run(schemaReview, { rating: 5 });
    assert.equal(nextCalled, true);
  });
});

describe('schemaLoginEmpresa', () => {
  // O schema de login aceita um identificador textual (CNPJ/Tax ID/e-mail) e
  // exige apenas a senha. O tamanho mínimo do identificador é aplicado por
  // `ensureLoginIdentifier` (usado em routes/authRoutes.ts), não pelo schema.
  it('aceita identificador textual e exige senha', () => {
    const { nextCalled } = run(schemaLoginEmpresa, { cnpj: '11222333000181', senha: 'x' });
    assert.equal(nextCalled, true);
  });

  it('ensureLoginIdentifier rejeita identificador curto', () => {
    const req: any = { body: { cnpj: '123', senha: 'x' } };
    const res = mockRes();
    let nextCalled = false;
    ensureLoginIdentifier(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
  });

  it('ensureLoginIdentifier aceita e-mail válido', () => {
    const req: any = { body: { email: 'dono@empresa.com', senha: 'x' } };
    const res = mockRes();
    let nextCalled = false;
    ensureLoginIdentifier(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });
});

describe('schemaCheckout', () => {
  it('rejeita plano inválido', () => {
    const { nextCalled, res } = run(schemaCheckout, { plano: 'gold' });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
  });

  it('aceita pro-anual', () => {
    const { nextCalled, req } = run(schemaCheckout, { plano: 'Pro-Anual' });
    assert.equal(nextCalled, true);
    assert.equal(req.body.plano, 'pro-anual');
  });
});
