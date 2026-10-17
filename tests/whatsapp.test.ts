import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizarWhatsapp, linkWhatsapp, mensagemPosCritica, mensagemEmpresaParaCliente } from '../lib/whatsapp.js';

describe('normalizarWhatsapp', () => {
  it('aceita número BR com DDD e prefixa 55', () => {
    assert.equal(normalizarWhatsapp('11999998888'), '5511999998888');
    assert.equal(normalizarWhatsapp('(11) 99999-8888'), '5511999998888');
    assert.equal(normalizarWhatsapp('11 99999 8888'), '5511999998888');
  });

  it('mantém DDI quando já presente', () => {
    assert.equal(normalizarWhatsapp('+55 11 99999-8888'), '5511999998888');
    assert.equal(normalizarWhatsapp('5511999998888'), '5511999998888');
  });

  it('rejeita vazio ou inválido', () => {
    assert.equal(normalizarWhatsapp(''), null);
    assert.equal(normalizarWhatsapp(null), null);
    assert.equal(normalizarWhatsapp(undefined), null);
    assert.equal(normalizarWhatsapp('123'), null);
    assert.equal(normalizarWhatsapp('9999'), null);
    assert.equal(normalizarWhatsapp('abcdefghij'), null);
  });

  it('rejeita números com tamanho absurdo', () => {
    assert.equal(normalizarWhatsapp('5511999998888123456'), null);
  });
});

describe('linkWhatsapp', () => {
  it('gera wa.me', () => {
    assert.equal(linkWhatsapp('11999998888'), 'https://wa.me/5511999998888');
  });

  it('inclui texto codificado', () => {
    const url = linkWhatsapp('11999998888', 'Olá mundo');
    assert.ok(url?.startsWith('https://wa.me/5511999998888?text='));
    assert.ok(url?.includes(encodeURIComponent('Olá mundo')));
  });

  it('retorna null sem telefone válido', () => {
    assert.equal(linkWhatsapp(''), null);
    assert.equal(linkWhatsapp(null), null);
  });
});

describe('mensagemEmpresaParaCliente (empresa → cliente)', () => {
  it('inclui referência de nota, empresa, comentário e cliente', () => {
    const m = mensagemEmpresaParaCliente({
      nomeEmpresa: 'Padaria',
      nomeCliente: 'Ana',
      rating: 2,
      comment: 'Demora',
    });
    assert.ok(m.includes('2★'));
    assert.ok(m.includes('Padaria'));
    assert.ok(m.includes('Demora'));
    assert.ok(m.includes('Ana'));
  });

  it('usa fallbacks quando dados ausentes', () => {
    const m = mensagemEmpresaParaCliente({ rating: 1 });
    assert.ok(m.includes('1★'));
    assert.ok(m.includes('nossa equipe'));
    assert.ok(m.startsWith('Olá!'));
  });
});

describe('mensagemPosCritica (cliente → empresa, alias legado)', () => {
  it('inclui empresa, comentário e assinatura do cliente', () => {
    const m = mensagemPosCritica({
      nomeEmpresa: 'Padaria',
      nomeCliente: 'Ana',
      rating: 2,
      comment: 'Demora',
    });
    assert.ok(m.includes('Padaria'));
    assert.ok(m.includes('Demora'));
    assert.ok(m.includes('Ana'));
  });

  it('usa fallback "vocês" e omite assinatura sem cliente', () => {
    const m = mensagemPosCritica({ rating: 1 });
    assert.ok(m.includes('vocês'));
    assert.ok(!m.includes('—'));
  });
});
