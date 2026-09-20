import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFollowupDraft } from '../lib/followupTemplate.js';

describe('buildFollowupDraft', () => {
  it('mantém a oferta de 7 dias sem cartão e o nome da empresa', () => {
    const draft = buildFollowupDraft('Empresa Teste');
    assert.match(draft, /Vi que a Empresa Teste está com uma avaliação abaixo do esperado no Google\./);
    assert.match(draft, /Você pode testar o Filtra\.AI gratuitamente por 7 dias, sem cartão de crédito:/);
    assert.match(draft, /https:\/\/filtraai\.com/);
    assert.doesNotMatch(draft, /avaliação automática ficou em avaliação \(0\/100\)/);
  });

  it('usa APP_URL quando configurado', () => {
    const previous = process.env.APP_URL;
    process.env.APP_URL = 'https://example.test/';
    try {
      const draft = buildFollowupDraft('Empresa Teste');
      assert.match(draft, /https:\/\/example\.test/);
      assert.doesNotMatch(draft, /https:\/\/example\.test\//);
    } finally {
      if (previous === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = previous;
    }
  });
});
