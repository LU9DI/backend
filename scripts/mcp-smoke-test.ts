const endpoint = process.env.MCP_URL || 'https://api.filtraai.com/mcp';

async function rpc(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });

  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`MCP returned non-JSON (HTTP ${response.status}): ${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}: ${JSON.stringify(body)}`);
  }

  if (typeof body !== 'object' || body === null || !('result' in body)) {
    throw new Error(`MCP JSON-RPC error: ${JSON.stringify(body)}`);
  }

  return {
    body: body as { result: any },
    sessionId: response.headers.get('mcp-session-id') || '',
  };
}

async function notification(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method, params }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MCP notification HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
}

async function main() {
  console.log(`MCP smoke test: ${endpoint}`);

  const init = await rpc(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'filtra-mcp-smoke-test', version: '1.0.0' },
  });

  const sessionId = init.sessionId;
  const sessionHeaders = sessionId ? { 'mcp-session-id': sessionId } : {};

  console.log(`✓ initialize${sessionId ? ' + session' : ''}`);

  await notification('notifications/initialized', {}, sessionHeaders);
  console.log('✓ notifications/initialized');

  const listed = await rpc(2, 'tools/list', {}, sessionHeaders);
  const tools = Array.isArray(listed.body.result?.tools) ? listed.body.result.tools : [];
  const names = tools.map((tool: any) => tool?.name).filter(Boolean);

  const expected = [
    'auditar_reputacao',
    'gerar_resposta_avaliacao',
    'iniciar_teste_filtraai',
    'sobre_filtraai',
  ];

  for (const name of expected) {
    if (!names.includes(name)) throw new Error(`Missing MCP tool: ${name}`);
  }

  console.log(`✓ tools/list: ${names.join(', ')}`);

  const calls = [
    [3, 'sobre_filtraai', {}],
    [4, 'iniciar_teste_filtraai', {}],
    [5, 'auditar_reputacao', {
      company: 'Restaurante Smoke Test',
      reviews: [
        { rating: 5, text: 'Atendimento excelente e comida muito boa.' },
        { rating: 2, text: 'Demorou muito e o pedido veio errado.' },
        { rating: 4, text: 'Boa experiência, mas o atendimento pode ser mais rápido.' },
      ],
      locale: 'pt-BR',
    }],
    [6, 'gerar_resposta_avaliacao', {
      company: 'Restaurante Smoke Test',
      rating: 2,
      review: 'Demorou muito e o pedido veio errado.',
      locale: 'pt-BR',
    }],
  ] as const;

  for (const [id, name, args] of calls) {
    const called = await rpc(id, 'tools/call', { name, arguments: args }, sessionHeaders);
    const result = called.body.result;

    if (result?.isError) {
      throw new Error(`Tool ${name} returned isError: ${JSON.stringify(result)}`);
    }

    if (!result?.structuredContent || typeof result.structuredContent !== 'object') {
      throw new Error(`Tool ${name} returned no structuredContent`);
    }

    console.log(`✓ tools/call: ${name}`);
  }

  console.log('MCP external smoke test passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
