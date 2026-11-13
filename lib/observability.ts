/**
 * Observabilidade do Filtra Dot — logs estruturados com correlação.
 *
 * Regras:
 *  - uma linha JSON por evento (Render coleta stdout sem parser próprio);
 *  - `request_id` vem do `X-Request-Id` já aceito/saneado pelo middleware;
 *  - `empresa_id` é o tenant autenticado (nunca o token);
 *  - conteúdo de cliente (mensagem, prompt, e-mail, telefone, credenciais)
 *    nunca é registrado: chaves sensíveis são redigidas e strings passam por
 *    uma segunda barreira que remove Bearer/JWT.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type ObservabilityContext = {
  requestId: string;
  empresaId?: string | null;
  route?: string;
};

export type LogLevel = 'info' | 'warn' | 'error';

export type LogSink = (line: string) => void;

const storage = new AsyncLocalStorage<ObservabilityContext>();

/** Chaves cujo valor jamais deve aparecer no log. */
const SENSITIVE_KEY =
  /^(authorization|cookie|set-cookie|password|senha|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|idempotency[_-]?key|prompt|message|content|payload|body|text|email|whatsapp|telefone|cpf|cnpj)$/i;

const SENSITIVE_VALUE = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
  /\b(?:sk|pk|gho|ghp|xox[baprs])_[A-Za-z0-9_-]{8,}\b/g,
];

let sink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

/** Substitui o destino dos eventos (usado em testes). */
export function setObservabilitySink(next: LogSink): void {
  sink = next;
}

export function resetObservabilitySink(): void {
  sink = (line) => {
    process.stdout.write(`${line}\n`);
  };
}

export function runWithObservability<T>(context: ObservabilityContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

export function currentObservabilityContext(): ObservabilityContext | undefined {
  return storage.getStore();
}

export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}

/** Vincula o tenant autenticado ao contexto assíncrono da requisição. */
export function bindTenant(empresaId: string | null | undefined): void {
  const context = storage.getStore();
  if (!context) return;
  context.empresaId = empresaId ? String(empresaId) : null;
}

export function scrubString(value: string, maxLength = 240): string {
  let text = value;
  for (const pattern of SENSITIVE_VALUE) text = text.replace(pattern, '[redacted]');
  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return scrubString(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      status: (value as { status?: unknown }).status ?? undefined,
      code: (value as { code?: unknown }).code ?? undefined,
    };
  }
  if (depth <= 0) return '[object]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item, depth - 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = '[redacted]';
        continue;
      }
      out[key] = sanitizeValue(item, depth - 1);
    }
    return out;
  }
  return scrubString(String(value));
}

export function sanitizeFields(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return sanitizeValue(fields, 3) as Record<string, unknown>;
}

export type LogEvent = {
  ts: string;
  level: LogLevel;
  event: string;
  request_id: string | null;
  empresa_id: string | null;
  [key: string]: unknown;
};

export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): LogEvent {
  const context = storage.getStore();
  const record: LogEvent = {
    ts: new Date().toISOString(),
    level,
    event,
    request_id: context?.requestId ?? null,
    empresa_id: context?.empresaId ?? null,
    ...sanitizeFields(fields),
  };
  try {
    sink(JSON.stringify(record));
  } catch {
    /* logging nunca derruba a requisição */
  }
  return record;
}
