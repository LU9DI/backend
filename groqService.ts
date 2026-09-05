/**
 * Camada de IA com balanceamento + failover + métricas de latência.
 *
 * AI_LOAD_BALANCE: round_robin | weighted | failover
 * Circuit breaker: AI_CB_FAILURES / AI_CB_COOLDOWN_MS
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_BASE =
  process.env.GEMINI_API_BASE ||
  'https://generativelanguage.googleapis.com/v1beta';

const LATENCY_WINDOW = Math.max(50, Number(process.env.METRICS_WINDOW || 200));

export type AiProvider = 'groq' | 'gemini';
export type LoadBalanceMode = 'round_robin' | 'weighted' | 'failover';

export type AiCallResult = {
  text: string;
  provider: AiProvider;
  latency_ms: number;
};

let rrIndex = 0;

type ProviderStats = {
  success: number;
  fail: number;
  consecutiveFails: number;
  cooldownUntil: number;
  lastError?: string;
  lastUsedAt?: number;
  /** amostras de latência (ms) — sucesso e falha */
  latencySamples: number[];
  latencySum: number;
  latencyCount: number;
  lastLatencyMs?: number;
};

function emptyStats(): ProviderStats {
  return {
    success: 0,
    fail: 0,
    consecutiveFails: 0,
    cooldownUntil: 0,
    latencySamples: [],
    latencySum: 0,
    latencyCount: 0,
  };
}

const stats: Record<AiProvider, ProviderStats> = {
  groq: emptyStats(),
  gemini: emptyStats(),
};

function cbFailures(): number {
  return Math.max(1, Number(process.env.AI_CB_FAILURES || 3));
}
function cbCooldownMs(): number {
  return Math.max(1000, Number(process.env.AI_CB_COOLDOWN_MS || 60_000));
}

function recordLatency(p: AiProvider, ms: number) {
  const s = stats[p];
  s.latencySamples.push(ms);
  if (s.latencySamples.length > LATENCY_WINDOW) s.latencySamples.shift();
  s.latencySum += ms;
  s.latencyCount += 1;
  s.lastLatencyMs = ms;
}

function pct(samples: number[], p: number): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[idx];
}

function latencySummary(s: ProviderStats) {
  const samples = s.latencySamples;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: s.latencyCount,
    window: samples.length,
    avg_ms: s.latencyCount ? Math.round(s.latencySum / s.latencyCount) : null,
    last_ms: s.lastLatencyMs ?? null,
    min_ms: sorted.length ? sorted[0] : null,
    max_ms: sorted.length ? sorted[sorted.length - 1] : null,
    p50_ms: pct(samples, 50),
    p95_ms: pct(samples, 95),
  };
}

function markSuccess(p: AiProvider, ms: number) {
  const s = stats[p];
  s.success += 1;
  s.consecutiveFails = 0;
  s.cooldownUntil = 0;
  s.lastUsedAt = Date.now();
  recordLatency(p, ms);
}

function markFail(p: AiProvider, err: any, ms: number) {
  const s = stats[p];
  s.fail += 1;
  s.consecutiveFails += 1;
  s.lastError = String(err?.message || err).slice(0, 200);
  s.lastUsedAt = Date.now();
  recordLatency(p, ms);
  if (s.consecutiveFails >= cbFailures()) {
    s.cooldownUntil = Date.now() + cbCooldownMs();
    console.warn(
      `[IA] Circuit aberto em ${p} por ${cbCooldownMs()}ms após ${s.consecutiveFails} falhas`
    );
  }
}

function isCoolingDown(p: AiProvider): boolean {
  return Date.now() < stats[p].cooldownUntil;
}

export function getAiLoadStats() {
  const now = Date.now();
  const pack = (p: AiProvider) => ({
    success: stats[p].success,
    fail: stats[p].fail,
    consecutiveFails: stats[p].consecutiveFails,
    lastError: stats[p].lastError,
    lastUsedAt: stats[p].lastUsedAt,
    cooling: isCoolingDown(p),
    cooldown_remaining_ms: Math.max(0, stats[p].cooldownUntil - now),
    latency: latencySummary(stats[p]),
  });
  return {
    mode: getLoadBalanceMode(),
    providers: listAiProviders(),
    stats: {
      groq: pack('groq'),
      gemini: pack('gemini'),
    },
  };
}

function groqKey(): string {
  return (process.env.GROQ_API_KEY || '').trim();
}
function geminiKey(): string {
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
}

export function listAiProviders(): AiProvider[] {
  const order = (process.env.AI_PROVIDER_ORDER || 'groq,gemini')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is AiProvider => s === 'groq' || s === 'gemini');

  const available: AiProvider[] = [];
  for (const p of order.length ? order : (['groq', 'gemini'] as AiProvider[])) {
    if (p === 'groq' && groqKey() && !available.includes('groq')) available.push('groq');
    if (p === 'gemini' && geminiKey() && !available.includes('gemini')) available.push('gemini');
  }
  return available;
}

export function aiConfigured(): boolean {
  return listAiProviders().length > 0;
}

function getLoadBalanceMode(): LoadBalanceMode {
  const m = (process.env.AI_LOAD_BALANCE || '').toLowerCase();
  if (m === 'weighted' || m === 'failover' || m === 'round_robin') return m;
  return listAiProviders().length > 1 ? 'round_robin' : 'failover';
}

function weightOf(p: AiProvider): number {
  if (p === 'groq') return Math.max(0, Number(process.env.AI_WEIGHT_GROQ || 50));
  return Math.max(0, Number(process.env.AI_WEIGHT_GEMINI || 50));
}

function buildAttemptOrder(): AiProvider[] {
  const all = listAiProviders().filter((p) => !isCoolingDown(p));
  const pool = all.length ? all : listAiProviders();
  if (!pool.length) return [];

  const mode = getLoadBalanceMode();
  let primary: AiProvider;

  if (mode === 'failover' || pool.length === 1) {
    primary = pool[0];
  } else if (mode === 'weighted') {
    const total = pool.reduce((s, p) => s + weightOf(p), 0) || 1;
    let r = Math.random() * total;
    primary = pool[pool.length - 1];
    for (const p of pool) {
      r -= weightOf(p);
      if (r <= 0) {
        primary = p;
        break;
      }
    }
  } else {
    primary = pool[rrIndex % pool.length];
    rrIndex = (rrIndex + 1) % 1_000_000;
  }

  const rest = pool.filter((p) => p !== primary);
  const cooling = listAiProviders().filter((p) => !pool.includes(p));
  return [primary, ...rest, ...cooling];
}

function shouldFailover(status: number, body: string): boolean {
  if ([401, 402, 403, 429, 500, 502, 503, 504].includes(status)) return true;
  const b = body.toLowerCase();
  return (
    b.includes('rate limit') ||
    b.includes('quota') ||
    b.includes('insufficient') ||
    b.includes('billing') ||
    b.includes('credit') ||
    b.includes('resource_exhausted') ||
    b.includes('exceeded')
  );
}

async function callGroq(
  system: string,
  user: string,
  maxTokens: number,
  temperature: number
): Promise<string> {
  const key = groqKey();
  if (!key) throw new Error('GROQ_API_KEY não configurada');

  const body = {
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
    temperature,
  };

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  const errorText = response.ok ? '' : await response.text();
  if (!response.ok) {
    const err: any = new Error(`Groq API error ${response.status}: ${errorText}`);
    err.status = response.status;
    err.body = errorText;
    err.failover = shouldFailover(response.status, errorText);
    throw err;
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq retornou resposta vazia');
  return String(text).trim();
}

async function callGemini(
  system: string,
  user: string,
  maxTokens: number,
  temperature: number
): Promise<string> {
  const key = geminiKey();
  if (!key) throw new Error('GEMINI_API_KEY não configurada');

  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const errorText = response.ok ? '' : await response.text();
  if (!response.ok) {
    const err: any = new Error(`Gemini API error ${response.status}: ${errorText}`);
    err.status = response.status;
    err.body = errorText;
    err.failover = shouldFailover(response.status, errorText);
    throw err;
  }

  const data = await response.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '';
  if (!text.trim()) throw new Error('Gemini retornou resposta vazia');
  return text.trim();
}

async function invokeProvider(
  provider: AiProvider,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number
): Promise<string> {
  return provider === 'groq'
    ? callGroq(system, user, maxTokens, temperature)
    : callGemini(system, user, maxTokens, temperature);
}

export async function callAI(
  system: string,
  user: string,
  maxTokens = 180,
  temperature = 0.6
): Promise<AiCallResult> {
  const order = buildAttemptOrder();
  if (!order.length) {
    throw new Error(
      'Nenhuma IA configurada. Defina GROQ_API_KEY e/ou GEMINI_API_KEY no .env'
    );
  }

  let lastError: Error | null = null;

  for (let i = 0; i < order.length; i++) {
    const provider = order[i];
    const t0 = process.hrtime.bigint();
    try {
      const text = await invokeProvider(provider, system, user, maxTokens, temperature);
      const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
      markSuccess(provider, ms);
      if (i > 0) {
        console.warn(`[IA] Fallback: ${provider} (${ms}ms)`);
      } else if (process.env.AI_LOG_LATENCY === '1') {
        console.log(`[IA] ${provider} ok ${ms}ms`);
      }
      return { text, provider, latency_ms: ms };
    } catch (e: any) {
      const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
      markFail(provider, e, ms);
      lastError = e;
      if (i < order.length - 1) {
        console.warn(
          `[IA] ${provider} falhou em ${ms}ms (${e?.status || e?.message}) → próximo...`
        );
        continue;
      }
    }
  }

  throw lastError || new Error('Falha em todos os providers de IA');
}

async function callLLM(
  system: string,
  user: string,
  maxTokens = 180,
  temperature = 0.6
): Promise<string> {
  const r = await callAI(system, user, maxTokens, temperature);
  return r.text;
}

export async function gerarRespostaReview(
  nomeCliente: string,
  rating: number,
  comment: string,
  nomeEmpresa?: string,
  exemplosEstilo?: string
): Promise<string> {
  const local = nomeEmpresa ? ` do estabelecimento "${nomeEmpresa}"` : '';

  let system =
    'Você responde avaliações negativas de clientes de forma empática, profissional e breve (máximo 3 frases). Peça desculpas quando apropriado e indique que a equipe vai analisar. Não invente políticas ou promessas específicas.';

  if (exemplosEstilo && exemplosEstilo.trim().length > 20) {
    system += `\n\nImite o estilo de escrita do dono do negócio com base nestes exemplos de respostas anteriores dele:\n---\n${exemplosEstilo.slice(0, 1500)}\n---\nMantenha o mesmo tom, vocabulário e formalidade.`;
  }

  const prompt = `Cliente: ${nomeCliente || 'Anônimo'}
Nota: ${rating}/5
Comentário: ${comment}

Escreva uma resposta curta para esta avaliação negativa${local}.`;

  return callLLM(system, prompt);
}

export async function gerarTagsSemanticas(
  rating: number,
  comment: string
): Promise<string[]> {
  if (!comment || comment.trim().length < 3) {
    if (rating >= 4) return ['#ExperienciaPositiva'];
    if (rating <= 2) return ['#ExperienciaNegativa'];
    return ['#Neutro'];
  }

  const system = `Você analisa avaliações de estabelecimentos comerciais.
Retorne APENAS um JSON array de 1 a 5 tags em português no formato hashtag CamelCase, sem espaços.
Exemplos válidos: ["#AtendimentoRuim","#ComidaExcelente","#PrecoAlto","#AmbienteAgradavel"]
Não explique. Não use markdown. Apenas o array JSON.`;

  const user = `Nota: ${rating}/5
Comentário: ${comment}`;
  const raw = await callLLM(system, user, 120, 0.3);

  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((t: unknown) => String(t).trim())
      .filter((t: string) => t.startsWith('#') && t.length > 2 && t.length < 40)
      .slice(0, 5);
  } catch {
    const matches = raw.match(/#[\wÀ-ú]+/g);
    return matches ? matches.slice(0, 5) : [];
  }
}
