const endpoint = process.env.MCP_URL || 'https://api.filtraai.com/mcp';

async function rpc(id: number, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
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

  return body as { result: any };
}

async function main() {
  console.log(`MCP smoke test: ${endpoint}`);

  const init = await rpc(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'filtra-mcp-smoke-test', version: '1.0.0' },
  });

  const sessionId = String(init.result?._meta?.sessionId || '');
  const sessionHeaders = sessionId ? { 'mcp-session-id': sessionId } : {};

  console.log('✓ initialize');

  const listed = await rpc(2, 'tools/list', {}, sessionHeaders);
  const tools = Array.isArray(listed.result?.tools) ? listed.result.tools : [];
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

  for (const [id, name] of [[3, 'sobre_filtraai'], [4, 'iniciar_teste_filtraai']] as const) {
    const called = await rpc(id, 'tools/call', { name, arguments: {} }, sessionHeaders);
    const result = called.result;

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
