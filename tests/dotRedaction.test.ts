import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSensitive } from '../routes/dotRoutes.js';

test('não trata datas como telefone', () => {
  assert.equal(redactSensitive('atendimento em 2026-10-05 foi ruim'), 'atendimento em 2026-10-05 foi ruim');
  assert.equal(redactSensitive('nota 4,8 com 1.284 avaliações'), 'nota 4,8 com 1.284 avaliações');
});

test('redige telefones, e-mails e tokens', () => {
  assert.match(redactSensitive('ligue (62) 99999-1234 agora'), /\[REDACTED_PHONE\]/);
  assert.match(redactSensitive('+55 62 99999-1234'), /\[REDACTED_PHONE\]/);
  assert.match(redactSensitive('fale com joao@empresa.com.br'), /\[REDACTED_EMAIL\]/);
  assert.match(redactSensitive('api_key=abc123secretvalue'), /api_key=\[REDACTED\]/i);
});
