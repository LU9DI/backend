import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidEmail } from '../lib/emailValidation.js';

test('aceita e-mails válidos (inclusive com a letra "s" e com ponto no domínio)', () => {
  for (const e of ['joao@empresa.com.br', 'contato@sindicato.org', 'a@b.co', 'Maria@Gmail.com', ' x@y.io ']) {
    assert.equal(isValidEmail(e), true, e);
  }
});

test('rejeita e-mails inválidos', () => {
  for (const e of ['', 'sem-arroba', 'a@b', '@b.com', 'a@.com', 'a b@c.com', 'a@@b.com', null, undefined]) {
    assert.equal(isValidEmail(e), false, String(e));
  }
});
