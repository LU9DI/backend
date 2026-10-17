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


async function modernRpc(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      ...(method === 'tools/call' && typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });

  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Modern MCP returned non-JSON (HTTP ${response.status}): ${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`Modern MCP HTTP ${response.status}: ${JSON.stringify(body)}`);
  }

  if (!body?.result) {
    throw new Error(`Modern MCP JSON-RPC error: ${JSON.stringify(body)}`);
  }

  return body.result;
}

async function modernSmoke() {
  const discover = await modernRpc(100, 'server/discover', {
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'filtra-mcp-modern-smoke', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  });

  if (!Array.isArray(discover.supportedVersions) || !discover.supportedVersions.includes('2026-07-28')) {
    throw new Error(`Modern discovery does not advertise 2026-07-28: ${JSON.stringify(discover)}`);
  }

  console.log('✓ modern server/discover: 2026-07-28');

  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'filtra-mcp-modern-smoke', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };

  const listed = await modernRpc(101, 'tools/list', { _meta: meta });
  const tools = Array.isArray(listed?.tools) ? listed.tools : [];
  const names = tools.map((tool: any) => tool?.name).filter(Boolean);
  for (const name of ['auditar_reputacao', 'gerar_resposta_avaliacao', 'iniciar_teste_filtraai', 'sobre_filtraai']) {
    if (!names.includes(name)) throw new Error(`Modern MCP missing tool: ${name}`);
  }
  console.log(`✓ modern tools/list: ${names.join(', ')}`);

  const result = await modernRpc(102, 'tools/call', {
    name: 'sobre_filtraai',
    arguments: {},
    _meta: meta,
  });

  if (result?.isError || !result?.structuredContent) {
    throw new Error(`Modern MCP tool call failed: ${JSON.stringify(result)}`);
  }

  console.log('✓ modern tools/call: sobre_filtraai');
}

async function main() {
  console.log(`MCP smoke test: ${endpoint}`);

  await modernSmoke();
  console.log('✓ modern MCP smoke complete');

  const init = await rpc(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'filtra-mcp-smoke-test', version: '1.0.0' },
  });

  const sessionId = init.sessionId;
  const sessionHeaders: Record<string, string> = sessionId ? { 'mcp-session-id': sessionId } : {};

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

  const auditTool = tools.find((tool: any) => tool?.name === 'auditar_reputacao');
  if (!auditTool?.inputSchema || !auditTool?.outputSchema) {
    throw new Error('auditar_reputacao is missing inputSchema/outputSchema');
  }
  const auditOutput = auditTool.outputSchema;
  const required = Array.isArray(auditOutput.required) ? auditOutput.required : [];
  for (const field of ['summary', 'strengths', 'risks', 'recurring_themes', 'actions', 'confidence']) {
    if (!required.includes(field)) throw new Error(`auditar_reputacao outputSchema missing required field: ${field}`);
  }
  console.log('✓ tools/list schema contract: auditar_reputacao');

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

  const invalid = await rpc(7, 'tools/call', {
    name: 'auditar_reputacao',
    arguments: {
      company: 'x',
      reviews: [],
    },
  }, sessionHeaders);
  if (!invalid.body.result?.isError) {
    throw new Error(`Invalid input was not rejected: ${JSON.stringify(invalid.body.result)}`);
  }
  console.log('✓ input validation: invalid auditar_reputacao rejected');

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

// Arquivo executado como script (sem imports/exports, portanto não-módulo).
// O export vazio o torna um módulo ES, evitando colisão de escopo global
// (ex.: `main`) com outros scripts não-modulares durante o tsc.
export {};
