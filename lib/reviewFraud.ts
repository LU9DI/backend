/**
 * Anti-fraude de avaliações públicas.
 *
 * Camadas:
 * 1. Honeypot (campo oculto preenchido por bot)
 * 2. Rate limit por IP + empresa (memória + DB)
 * 3. Reclamação (≤3★) única por IP e por WhatsApp
 * 4. Comentário duplicado recente
 * 5. Padrões suspeitos (nome genérico + nota extrema em rajada)
 * 6. Flag is_test (não conta em métricas/PDF)
 */
import crypto from 'crypto';
import type { Database } from 'sqlite';

/** IP:empresa → timestamps recentes (processo) */
const recentHits = new Map<string, number[]>();

const MAX_PER_HOUR = 5;
const MAX_PER_DAY = 12;
/** Uma reclamação (nota ≤3) por dispositivo a cada 30 dias. */
const COMPLAINT_WINDOW_DAYS = Number(process.env.COMPLAINT_ONCE_DAYS || 30);
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

export class ReviewFraudError extends Error {
  status = 429;
  constructor(message: string, status = 429) {
    super(message);
    this.name = 'ReviewFraudError';
    this.status = status;
  }
}

export function hashIp(ip: string): string {
  const salt = process.env.FRAUD_IP_SALT || process.env.JWT_SECRET || 'filtra-fraud';
  return crypto.createHash('sha256').update(`${salt}|${ip}`).digest('hex').slice(0, 32);
}

export function clientIp(req: {
  headers?: Record<string, unknown>;
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  const xf = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  if (xf) return xf;
  return req.ip || req.socket?.remoteAddress || '0.0.0.0';
}

function prune(ts: number[], windowMs: number, now: number) {
  return ts.filter((t) => now - t < windowMs);
}

/** Rate limit em memória (rápido) */
export function checkMemoryRate(ip: string, empresaId: string): void {
  const key = `${ip}|${empresaId}`;
  const now = Date.now();
  let list = recentHits.get(key) || [];
  list = prune(list, 24 * 60 * 60 * 1000, now);
  const lastHour = list.filter((t) => now - t < 60 * 60 * 1000);
  if (lastHour.length >= MAX_PER_HOUR) {
    throw new ReviewFraudError(
      'Muitas avaliações deste dispositivo. Aguarde um pouco e tente de novo.'
    );
  }
  if (list.length >= MAX_PER_DAY) {
    throw new ReviewFraudError(
      'Limite diário de avaliações deste dispositivo atingido. Tente amanhã.'
    );
  }
  list.push(now);
  recentHits.set(key, list);
}

export async function ensureReviewFraudColumns(db: Database): Promise<void> {
  const cols = (await db.all(`PRAGMA table_info(reviews)`)).map((c: any) => c.name);
  const add = async (name: string, ddl: string) => {
    if (!cols.includes(name)) await db.exec(`ALTER TABLE reviews ADD COLUMN ${ddl}`);
  };
  await add('is_test', 'is_test INTEGER DEFAULT 0');
  await add('ip_hash', 'ip_hash TEXT');
  await add('fraud_flags', 'fraud_flags TEXT');
  await add('origin', 'origin TEXT');
  await add('client_whatsapp', 'client_whatsapp TEXT');
}

function normalizeComment(c: string): string {
  return c
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function checkDuplicateComment(
  db: Database,
  empresaId: string,
  comment: string
): Promise<void> {
  const n = normalizeComment(comment);
  if (n.length < 12) return;

  const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
  const rows = await db.all(
    `SELECT comment FROM reviews
     WHERE empresa_id = ? AND createdAt >= ? AND comment IS NOT NULL
     ORDER BY createdAt DESC LIMIT 40`,
    [empresaId, since]
  );
  for (const r of rows || []) {
    if (normalizeComment(String(r.comment || '')) === n) {
      throw new ReviewFraudError(
        'Este comentário já foi enviado recentemente. Evite repetições.',
        409
      );
    }
  }
}

export async function checkDbRateByIp(
  db: Database,
  empresaId: string,
  ipHash: string
): Promise<void> {
  const sinceHour = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const sinceDay = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const hour = await db.get(
    `SELECT COUNT(*) as c FROM reviews
     WHERE empresa_id = ? AND ip_hash = ? AND createdAt >= ? AND IFNULL(is_test,0) = 0`,
    [empresaId, ipHash, sinceHour]
  );
  if (Number(hour?.c || 0) >= MAX_PER_HOUR) {
    throw new ReviewFraudError(
      'Muitas avaliações deste dispositivo. Aguarde um pouco e tente de novo.'
    );
  }

  const day = await db.get(
    `SELECT COUNT(*) as c FROM reviews
     WHERE empresa_id = ? AND ip_hash = ? AND createdAt >= ? AND IFNULL(is_test,0) = 0`,
    [empresaId, ipHash, sinceDay]
  );
  if (Number(day?.c || 0) >= MAX_PER_DAY) {
    throw new ReviewFraudError(
      'Limite diário de avaliações deste dispositivo atingido. Tente amanhã.'
    );
  }
}

/**
 * Reclamação (nota ≤ 3): apenas 1 por dispositivo (IP) na janela configurável
 * e 1 por WhatsApp do cliente na mesma empresa.
 */
export async function checkOneComplaintOnly(
  db: Database,
  opts: {
    empresaId: string;
    ipHash: string;
    clientWhatsapp?: string | null;
    rating: number;
  }
): Promise<void> {
  if (opts.rating > 3) return;

  const days = Math.max(1, COMPLAINT_WINDOW_DAYS);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const byIp = await db.get(
    `SELECT COUNT(*) as c FROM reviews
     WHERE empresa_id = ? AND ip_hash = ? AND rating <= 3
       AND IFNULL(is_test,0) = 0 AND createdAt >= ?`,
    [opts.empresaId, opts.ipHash, since]
  );
  if (Number(byIp?.c || 0) >= 1) {
    throw new ReviewFraudError(
      'Você já enviou uma reclamação recentemente para este estabelecimento. Aguarde ou fale pelo WhatsApp da empresa.',
      409
    );
  }

  const wpp = (opts.clientWhatsapp || '').replace(/\D/g, '');
  if (wpp.length >= 10) {
    const byWpp = await db.get(
      `SELECT COUNT(*) as c FROM reviews
       WHERE empresa_id = ? AND client_whatsapp = ? AND rating <= 3
         AND IFNULL(is_test,0) = 0 AND createdAt >= ?`,
      [opts.empresaId, wpp, since]
    );
    if (Number(byWpp?.c || 0) >= 1) {
      throw new ReviewFraudError(
        'Este WhatsApp já registrou uma reclamação para este estabelecimento no período.',
        409
      );
    }
  }
}

/** Heurísticas leves — não bloqueiam sozinhas, só marcam flags */
export function softFraudFlags(opts: {
  name: string;
  comment: string;
  rating: number;
}): string[] {
  const flags: string[] = [];
  const name = opts.name.trim().toLowerCase();
  const comment = opts.comment.trim();

  if (!name || name === 'anônimo' || name === 'anonimo' || name === 'teste' || name === 'test') {
    flags.push('nome_generico');
  }
  if (opts.rating === 1 || opts.rating === 5) {
    flags.push('nota_extrema');
  }
  if (comment.length > 0 && comment.length < 8 && opts.rating <= 3) {
    flags.push('comentario_curto');
  }
  if (/(.)\1{4,}/.test(comment)) {
    flags.push('padrao_repetido');
  }
  return flags;
}

export function assertNotHoneypot(honeypot: string | undefined | null): void {
  if (honeypot && String(honeypot).trim()) {
    throw new ReviewFraudError('Não foi possível enviar sua avaliação.', 400);
  }
}
