import test from 'node:test';
import assert from 'node:assert/strict';
import { inSendWindow } from '../lib/acquisitionWindow.js';
import { enviarEmailAquisicao } from '../lib/mailer.js';

// Horários em UTC; Brasília = UTC-3 (sem horário de verão).
const seg10h = new Date('2026-10-05T13:00:00Z'); // segunda 10h
const seg08h = new Date('2026-10-05T11:00:00Z'); // segunda 8h
const seg17h = new Date('2026-10-05T20:00:00Z'); // segunda 17h (fora: fim exclusivo)
const dom10h = new Date('2026-10-04T13:00:00Z'); // domingo 10h

test('janela de envio: horário comercial em dia útil', () => {
  delete process.env.ACQUISITION_SEND_HOURS;
  delete process.env.ACQUISITION_SEND_WEEKENDS;
  assert.equal(inSendWindow(seg10h), true);
  assert.equal(inSendWindow(seg08h), false);
  assert.equal(inSendWindow(seg17h), false);
  assert.equal(inSendWindow(dom10h), false);
});

test('janela de envio: fim de semana liberado por env', () => {
  process.env.ACQUISITION_SEND_WEEKENDS = '1';
  assert.equal(inSendWindow(dom10h), true);
  delete process.env.ACQUISITION_SEND_WEEKENDS;
});

test('janela de envio: horas configuráveis e valor inválido volta ao padrão', () => {
  process.env.ACQUISITION_SEND_HOURS = '8-12';
  assert.equal(inSendWindow(seg08h), true);
  assert.equal(inSendWindow(seg10h), true);
  process.env.ACQUISITION_SEND_HOURS = 'abc';
  assert.equal(inSendWindow(seg10h), true);
  assert.equal(inSendWindow(seg08h), false);
  delete process.env.ACQUISITION_SEND_HOURS;
});

test('captação é bloqueada sem ACQUISITION_REPLY_TO', async () => {
  process.env.ACQUISITION_ENGINE = '1';
  process.env.RESEND_API_KEY = 're_test';
  delete process.env.ACQUISITION_REPLY_TO;
  const result = await enviarEmailAquisicao({ to: 'a@empresa.com.br', subject: 's', text: 't' });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /ACQUISITION_REPLY_TO/);
});

test('captação envia reply_to para a Resend quando configurado', async () => {
  process.env.ACQUISITION_ENGINE = '1';
  process.env.RESEND_API_KEY = 're_test';
  process.env.ACQUISITION_REPLY_TO = 'contato@exemplo.com';
  const realFetch = globalThis.fetch;
  let sentBody: any = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    sentBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await enviarEmailAquisicao({ to: 'A@Empresa.com.br', subject: 's', text: 't' });
    assert.equal(result.ok, true);
    assert.equal(sentBody.reply_to, 'contato@exemplo.com');
    assert.deepEqual(sentBody.to, ['a@empresa.com.br']);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.ACQUISITION_REPLY_TO;
  }
});
