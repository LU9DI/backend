import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

describe('n8n integration', () => {
  const keys = ['N8N_WEBHOOK_URL', 'N8N_ENABLED', 'N8N_WEBHOOK_SECRET', 'N8N_INBOUND_SECRET', 'NODE_ENV'];
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of keys) prev[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of keys) {
      const v = prev[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('não considera n8n configurado sem URL', async () => {
    delete process.env.N8N_WEBHOOK_URL;
    const { n8nConfigured } = await import('../lib/n8n.js');
    assert.equal(n8nConfigured(), false);
  });

  it('respeita N8N_ENABLED=0', async () => {
    process.env.N8N_WEBHOOK_URL = 'https://example.com/webhook';
    process.env.N8N_ENABLED = '0';
    const { n8nConfigured } = await import('../lib/n8n.js');
    assert.equal(n8nConfigured(), false);
  });

  it('exige segredo de entrada em produção', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.N8N_INBOUND_SECRET;
    delete process.env.N8N_WEBHOOK_SECRET;
    const { verifyInboundSecret } = await import('../lib/n8n.js');
    assert.equal(verifyInboundSecret(undefined), false);
    assert.equal(verifyInboundSecret('qualquer'), false);
  });

  it('aceita o segredo configurado', async () => {
    process.env.NODE_ENV = 'production';
    process.env.N8N_INBOUND_SECRET = 'segredo-teste';
    const { verifyInboundSecret } = await import('../lib/n8n.js');
    assert.equal(verifyInboundSecret('segredo-teste'), true);
    assert.equal(verifyInboundSecret('errado'), false);
  });

  it('envia evento com autenticação e payload', async () => {
    process.env.N8N_WEBHOOK_URL = 'https://example.com/webhook';
    process.env.N8N_WEBHOOK_SECRET = 'segredo-saida';

    const originalFetch = globalThis.fetch;
    let captured: { url: string; init?: RequestInit } | null = null;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response('', { status: 200 });
    }) as typeof fetch;

    try {
      const { notifyN8nAsync } = await import('../lib/n8n.js');
      const ok = await notifyN8nAsync('lead.qualified', { lead_id: 'abc', score: 82 });
      assert.equal(ok, true);
      assert.equal(captured?.url, 'https://example.com/webhook');
      assert.equal(captured?.init?.method, 'POST');

      const headers = new Headers(captured?.init?.headers);
      assert.equal(headers.get('X-Filtra-Secret'), 'segredo-saida');

      const body = JSON.parse(String(captured?.init?.body));
      assert.equal(body.event, 'lead.qualified');
      assert.equal(body.lead_id, 'abc');
      assert.equal(body.score, 82);
      assert.equal(body.source, 'filtra-ai');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
