import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cnpjValido, normalizarCnpj } from '../lib/cnpj.js';

describe('normalizarCnpj', () => {
  it('remove máscara', () => {
    assert.equal(normalizarCnpj('11.222.333/0001-81'), '11222333000181');
  });
});

describe('cnpjValido', () => {
  it('rejeita vazio e repetidos', () => {
    assert.equal(cnpjValido(''), false);
    assert.equal(cnpjValido('00000000000000'), false);
    assert.equal(cnpjValido('11111111111111'), false);
  });

  it('rejeita tamanho errado', () => {
    assert.equal(cnpjValido('123'), false);
  });

  // CNPJ de exemplo válido conhecido (Receita / geradores de teste)
  it('aceita CNPJ válido 11.222.333/0001-81', () => {
    assert.equal(cnpjValido('11.222.333/0001-81'), true);
  });

  it('rejeita dígito verificador errado', () => {
    assert.equal(cnpjValido('11222333000180'), false);
  });
});
