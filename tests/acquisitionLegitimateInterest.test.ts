import test from 'node:test';
import assert from 'node:assert/strict';
import { isCorporateEmail, canContactByLegitimateInterest, legitDailyCap } from '../lib/acquisitionLegitimateInterest.js';

test('e-mail corporativo: aceita domínio próprio e recusa gratuito/público/inválido', () => {
  assert.equal(isCorporateEmail('contato@restaurantebom.com.br'), true);
  assert.equal(isCorporateEmail('reservas@hotelcentral.com.br'), true);
  assert.equal(isCorporateEmail('fulano@gmail.com'), false);
  assert.equal(isCorporateEmail('fulano@hotmail.com.br'), false);
  assert.equal(isCorporateEmail('fulano@outlook.com'), false);
  assert.equal(isCorporateEmail('x@prefeitura.go.gov.br'), false);
  assert.equal(isCorporateEmail('x@escola.edu.br'), false);
  assert.equal(isCorporateEmail('sem-arroba'), false);
  assert.equal(isCorporateEmail('x@usp.br'), false);
  assert.equal(isCorporateEmail('x@cps.sp.gov.br'), false);
});

test('legítimo interesse: desligado por padrão', () => {
  delete process.env.ACQUISITION_LEGIT_INTEREST;
  assert.equal(canContactByLegitimateInterest({ email: 'a@empresa.com.br', acquisition_contact_basis: 'b2b_public_prospect' }), false);
});

test('legítimo interesse: ligado exige base pública, e-mail corporativo e ausência de opt-in', () => {
  process.env.ACQUISITION_LEGIT_INTEREST = '1';
  try {
    assert.equal(canContactByLegitimateInterest({ email: 'a@empresa.com.br', acquisition_contact_basis: 'b2b_public_prospect' }), true);
    assert.equal(canContactByLegitimateInterest({ email: 'a@gmail.com', acquisition_contact_basis: 'b2b_public_prospect' }), false);
    assert.equal(canContactByLegitimateInterest({ email: 'a@empresa.com.br', acquisition_contact_basis: null }), false);
    assert.equal(canContactByLegitimateInterest({ email: 'a@empresa.com.br', acquisition_contact_basis: 'b2b_public_prospect', acquisition_opted_in_at: '2026-10-05' }), false);
  } finally { delete process.env.ACQUISITION_LEGIT_INTEREST; }
});

test('legítimo interesse: recusa entes públicos pelo nome mesmo com e-mail aparentemente comercial', () => {
  process.env.ACQUISITION_LEGIT_INTEREST = '1';
  try {
    for (const nome of ['Clínica da Família Raimundo Alves', 'Centro Municipal de Saúde X', 'Escola Técnica Cidade Tiradentes', 'Universidade Y']) {
      assert.equal(canContactByLegitimateInterest({ nome_empresa: nome, email: 'contato@empresa.com.br', acquisition_contact_basis: 'b2b_public_prospect' }), false, nome);
    }
    assert.equal(canContactByLegitimateInterest({ nome_empresa: 'Sushi Shima', email: 'contato@sushishima.com.br', acquisition_contact_basis: 'b2b_public_prospect' }), true);
  } finally { delete process.env.ACQUISITION_LEGIT_INTEREST; }
});

test('teto diário próprio: padrão 10, mínimo 1, máximo 30', () => {
  delete process.env.ACQUISITION_LEGIT_DAILY_CAP;
  assert.equal(legitDailyCap(), 10);
  process.env.ACQUISITION_LEGIT_DAILY_CAP = '999'; assert.equal(legitDailyCap(), 30);
  process.env.ACQUISITION_LEGIT_DAILY_CAP = '0'; assert.equal(legitDailyCap(), 1);
  delete process.env.ACQUISITION_LEGIT_DAILY_CAP;
});

test('mensagem por legítimo interesse informa origem, base legal e descadastro; opt-in não leva o aviso', async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const { buildMessage } = await import('../lib/acquisitionEngine.js');
  const legit = buildMessage({ id: 'l1', nome_empresa: 'Sushi Shima', acquisition_contact_basis: 'b2b_public_prospect' });
  assert.match(legit.body, /legítimo interesse/);
  assert.match(legit.body, /art\. 7º, IX/);
  assert.match(legit.body, /publicado em fonte pública/);
  assert.match(legit.body, /cancele aqui/);
  assert.match(legit.html, /legítimo interesse/);
  assert.match(legit.unsubscribeUrl, /unsubscribe\?l=l1/);
  const optin = buildMessage({ id: 'l2', nome_empresa: 'X', acquisition_opted_in_at: '2026-10-05', acquisition_contact_basis: 'b2b_public_prospect' });
  assert.doesNotMatch(optin.body, /legítimo interesse/);
});
