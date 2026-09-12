import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mensagemClienteParaEmpresa } from '../lib/whatsapp.js';

describe('mensagemClienteParaEmpresa', () => {
  it('não usa resposta da empresa/IA no texto do cliente', () => {
    const cliente = 'Demora no atendimento e ninguém respondeu.';
    const respostaEmpresa = 'Lamentamos o ocorrido e estamos trabalhando para resolver sua situação.';

    const mensagem = mensagemClienteParaEmpresa({
      nomeEmpresa: 'Padaria',
      nomeCliente: 'Ana',
      comment: cliente,
    });

    assert.ok(mensagem.includes(cliente));
    assert.ok(!mensagem.includes(respostaEmpresa));
    assert.ok(!mensagem.includes('Lamentamos o ocorrido'));
  });

  it('gera uma mensagem em primeira pessoa do cliente', () => {
    const mensagem = mensagemClienteParaEmpresa({
      nomeEmpresa: 'Padaria',
      nomeCliente: 'Ana',
      comment: 'Demora no atendimento.',
    });

    assert.ok(mensagem.includes('Acabei de registrar um feedback'));
    assert.ok(mensagem.includes('Gostaria de conversar para resolver isso.'));
    assert.ok(mensagem.includes('— Ana'));
  });
});
