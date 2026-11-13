/**
 * Verificação somente leitura do estado do Filtra Dot em um ambiente.
 *
 * Uso:
 *   npx tsx scripts/dot-containment-check.ts --expect enabled  --base-url https://filtra-ia-api.onrender.com
 *   npx tsx scripts/dot-containment-check.ts --expect disabled --base-url https://filtra-ia-api.onrender.com
 *
 * Sai com 0 quando o estado observado corresponde ao esperado e 1 caso
 * contrário. Não envia token, não escreve nada e não chama provedores.
 */
import { evaluateContainment, type ContainmentExpectation, type ProbeResult } from '../lib/dotContainmentCheck.js';

type Args = {
  baseUrl: string;
  expect: ContainmentExpectation;
  timeoutMs: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    baseUrl: (process.env.DOT_CHECK_BASE_URL || 'https://filtra-ia-api.onrender.com').trim(),
    expect: 'disabled',
    timeoutMs: 30_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base-url') args.baseUrl = String(argv[++index] || args.baseUrl).trim();
    else if (arg === '--expect') {
      const value = String(argv[++index] || '');
      if (value !== 'enabled' && value !== 'disabled') throw new Error('--expect deve ser enabled ou disabled');
      args.expect = value;
    } else if (arg === '--timeout') args.timeoutMs = Math.max(1_000, Number(argv[++index]) || args.timeoutMs);
    else if (arg === '--help' || arg === '-h') {
      console.log('Uso: npx tsx scripts/dot-containment-check.ts [--expect enabled|disabled] [--base-url URL] [--timeout ms]');
      process.exit(0);
    } else {
      throw new Error(`Argumento desconhecido: ${arg}`);
    }
  }
  args.baseUrl = args.baseUrl.replace(/\/+$/, '');
  return args;
}

async function probe(url: string, timeoutMs: number): Promise<ProbeResult> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [live, health, status, preferences] = await Promise.all([
    probe(`${args.baseUrl}/api/live`, args.timeoutMs),
    probe(`${args.baseUrl}/api/health`, args.timeoutMs),
    probe(`${args.baseUrl}/api/dot/status`, args.timeoutMs),
    probe(`${args.baseUrl}/api/dot/preferences`, args.timeoutMs),
  ]);

  const verdict = evaluateContainment({ live, health, status, preferences, expect: args.expect });
  console.log(JSON.stringify({ base_url: args.baseUrl, ...verdict }, null, 2));
  if (!verdict.ok) process.exit(1);
}

main().catch((error) => {
  console.error(`[dot-containment-check] erro fatal: ${String((error as Error)?.message || error)}`);
  process.exit(1);
});
