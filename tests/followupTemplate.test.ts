import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFollowupDraft } from '../lib/followupTemplate.js';

describe('buildFollowupDraft', () => {
  it('mantém a oferta de 7 dias sem cartão e o nome da empresa', () => {
    // O ambiente pode definir APP_URL/FRONTEND_URL; este caso valida o padrão público.
    const previousApp = process.env.APP_URL;
    const previousFront = process.env.FRONTEND_URL;
    delete process.env.APP_URL;
    delete process.env.FRONTEND_URL;
    try {
      const draft = buildFollowupDraft('Empresa Teste');
      assert.match(draft, /Vi que a Empresa Teste está com uma avaliação abaixo do esperado no Google\./);
      assert.match(draft, /Você pode testar o Filtra\.AI gratuitamente por 7 dias, sem cartão de crédito:/);
      assert.match(draft, /https:\/\/filtraai\.com/);
      assert.doesNotMatch(draft, /avaliação automática ficou em avaliação \(0\/100\)/);
    } finally {
      if (previousApp === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = previousApp;
      if (previousFront === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = previousFront;
    }
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
