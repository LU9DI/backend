#!/usr/bin/env node
import readline from 'node:readline';

const API_URL = String(process.env.FILTRA_API_URL || 'https://api.filtraai.com').replace(/\/$/, '');
const SECRET = String(process.env.FILTRA_MCP_SECRET || '').trim();

type JsonRpcMessage = {
  id?: unknown;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> } & Record<string, unknown>;
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function jsonrpc(id: unknown, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function error(id: unknown, code: number, message: string) {
  jsonrpc(id, { error: { code, message } });
}
async function callApi(path: string, method = 'GET', body?: unknown) {
  if (!SECRET) throw new Error('FILTRA_MCP_SECRET não configurado.');
  const res = await fetch(API_URL + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-filtra-secret': SECRET },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error('Filtra API ' + res.status + ': ' + (data?.error || text));
  return data;
}

const tools = [
  {
    name: 'filtra_acquisition_status',
    description: 'Consulta o estado persistente do motor de aquisição Filtra.AI: campanhas, conteúdos, oportunidades e eventos.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'filtra_record_acquisition_event',
    description: 'Registra um evento de aquisição observado pelo agente, como visita, clique, descoberta, publicação ou resposta. Não envia email.',
    inputSchema: {
      type: 'object',
      properties: {
        event_type: { type: 'string' },
        source: { type: 'string' },
        medium: { type: 'string' },
        campaign: { type: 'string' },
        content: { type: 'string' },
        lead_id: { type: 'string' },
        occurred_at: { type: 'string' },
        metadata: { type: 'object' }
      },
      required: ['event_type'],
      additionalProperties: false
    }
  },
  {
    name: 'filtra_upsert_campaign',
    description: 'Cria ou atualiza uma campanha de aquisição persistida no Filtra.AI.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, name: { type: 'string' }, platform: { type: 'string' },
        status: { type: 'string' }, utm_source: { type: 'string' }, utm_medium: { type: 'string' },
        utm_campaign: { type: 'string' }
      },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    name: 'filtra_upsert_content',
    description: 'Persiste conteúdo de divulgação/SEO/social com deduplicação por hash. Não publica automaticamente.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, campaign_id: { type: 'string' }, platform: { type: 'string' },
        title: { type: 'string' }, body: { type: 'string' }, content_hash: { type: 'string' },
        status: { type: 'string' }, scheduled_at: { type: 'string' }, published_at: { type: 'string' },
        external_post_id: { type: 'string' }, utm_content: { type: 'string' }, metadata: { type: 'object' }
      },
      required: ['platform', 'body'],
      additionalProperties: false
    }
  },
  {
    name: 'filtra_upsert_opportunity',
    description: 'Registra uma oportunidade legítima de divulgação encontrada pelo agente (comunidade, diretório, associação, parceria, etc.). Não publica automaticamente.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, platform: { type: 'string' }, title: { type: 'string' },
        url: { type: 'string' }, description: { type: 'string' }, relevance_score: { type: 'number' },
        opportunity_hash: { type: 'string' }, status: { type: 'string' }, draft: { type: 'string' },
        approval_required: { type: 'boolean' }, published_at: { type: 'string' }, metadata: { type: 'object' }
      },
      required: ['platform'],
      additionalProperties: false
    }
  }
];

async function handle(msg: JsonRpcMessage) {
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    return jsonrpc(id, {
      protocolVersion: params.protocolVersion || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'filtra-ai-acquisition', version: '1.0.0' }
    });
  }
  if (method === 'notifications/initialized') return;
  if (method === 'ping') return jsonrpc(id, {});
  if (method === 'tools/list') return jsonrpc(id, { tools });
  if (method !== 'tools/call') return error(id, -32601, 'Método não suportado.');
  const name = params?.name;
  const a = params?.arguments || {};
  try {
    let data;
    if (name === 'filtra_acquisition_status') {
      data = await callApi('/api/n8n/acquisition/status');
    } else if (name === 'filtra_record_acquisition_event') {
      data = await callApi('/api/n8n/acquisition/events', 'POST', a);
    } else if (name === 'filtra_upsert_campaign') {
      data = await callApi('/api/n8n/acquisition/campaigns/upsert', 'POST', a);
    } else if (name === 'filtra_upsert_content') {
      data = await callApi('/api/n8n/acquisition/content/upsert', 'POST', a);
    } else if (name === 'filtra_upsert_opportunity') {
      data = await callApi('/api/n8n/acquisition/opportunities/upsert', 'POST', a);
    } else {
      return error(id, -32602, 'Tool desconhecida: ' + name);
    }
    return jsonrpc(id, { content: [{ type: 'text', text: JSON.stringify(data) }] });
  } catch (e) {
    return error(id, -32000, errorMessage(e));
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  try { await handle(JSON.parse(line)); }
  catch (e) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: errorMessage(e) } }) + '\n'); }
});
