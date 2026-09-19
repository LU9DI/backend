/**
 * Anti-fraude de avaliações públicas.
 *
 * Regra de negócio: reclamação (≤3★) = **uma vez** por dispositivo e por WhatsApp
 * na janela (padrão 30 dias). Depois o cliente deve falar com a empresa no WPP,
 * não abrir outro feedback (ex.: “quero que peçam desculpas”).
 */
import crypto from 'crypto';
import type { Database } from 'sqlite';

const recentHits = new Map<string, number[]>();

const MAX_PER_HOUR = 5;
const MAX_PER_DAY = 12;
const COMPLAINT_WINDOW_DAYS = Number(process.env.COMPLAINT_ONCE_DAYS || 30);
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

const MSG_JA_RECLAMOU =
  'Você já registrou uma reclamação neste estabelecimento. ' +
  'Para resolver (ou pedir retorno), fale pelo WhatsApp da empresa — ' +
  'não é necessário enviar outro feedback.';

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
  // Express está configurado com trust proxy; prefira req.ip para não aceitar X-Forwarded-For forjado.
  if (req.ip) return req.ip;
  if (req.socket?.remoteAddress) return req.socket.remoteAddress;
  const xf = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return xf || '0.0.0.0';
}

function prune(ts: number[], windowMs: number, now: number) {
  return ts.filter((t) => now - t < windowMs);
}

function onlyDigits(s: string): string {
  return String(s || '').replace(/\D/g, '');
}

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
  const cols = [
    'is_test INTEGER DEFAULT 0',
    'ip_hash TEXT',
    'fraud_flags TEXT',
    'origin TEXT',
    'client_whatsapp TEXT',
  ];
  for (const ddl of cols) {
    try {
      await db.exec(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS ${ddl}`);
    } catch {
      try {
        await db.exec(`ALTER TABLE reviews ADD COLUMN ${ddl}`);
      } catch {
        /* já existe */
      }
    }
  }
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
  let rows: any[] = [];
  try {
    rows = await db.all(
      `SELECT comment FROM reviews
       WHERE empresa_id = ? AND createdAt >= ? AND comment IS NOT NULL
       ORDER BY id DESC LIMIT 40`,
      [empresaId, since]
    );
  } catch {
    return;
  }
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

  try {
    const hour = await db.get(
      `SELECT COUNT(*) as c FROM reviews
       WHERE empresa_id = ? AND ip_hash = ? AND createdAt >= ? AND COALESCE(is_test,0) = 0`,
      [empresaId, ipHash, sinceHour]
    );
    if (Number(hour?.c || 0) >= MAX_PER_HOUR) {
      throw new ReviewFraudError(
        'Muitas avaliações deste dispositivo. Aguarde um pouco e tente de novo.'
      );
    }

    const day = await db.get(
      `SELECT COUNT(*) as c FROM reviews
       WHERE empresa_id = ? AND ip_hash = ? AND createdAt >= ? AND COALESCE(is_test,0) = 0`,
      [empresaId, ipHash, sinceDay]
    );
    if (Number(day?.c || 0) >= MAX_PER_DAY) {
      throw new ReviewFraudError(
        'Limite diário de avaliações deste dispositivo atingido. Tente amanhã.'
      );
    }
  } catch (e: any) {
    if (e instanceof ReviewFraudError) throw e;
    console.warn('checkDbRateByIp:', e?.message || e);
  }
}

/**
 * Reclamação (nota ≤ 3): **1x** por IP e **1x** por WhatsApp na janela.
 * O cliente não deve abrir outro formulário para “pedir desculpas” — usa o WPP.
 */
/** Uma pessoa/IP só pode enviar 1 feedback por empresa. */
export async function checkOneFeedbackOnly(
  db: Database,
  empresaId: string,
  ipHash: string
): Promise<void> {
  const existing = await db.get(
    `SELECT COUNT(*) as c FROM reviews
     WHERE empresa_id = ? AND ip_hash = ? AND IFNULL(is_test,0) = 0`,
    [empresaId, ipHash]
  );
  if (Number(existing?.c || 0) >= 1) {
    throw new ReviewFraudError(
      'Você já enviou um feedback para este estabelecimento. Cada usuário pode enviar apenas um feedback.',
      409
    );
  }
}

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

  try {
    const byIp = await db.get(
      `SELECT COUNT(*) as c FROM reviews
       WHERE empresa_id = ? AND ip_hash = ? AND rating <= 3
         AND COALESCE(is_test,0) = 0 AND createdAt >= ?`,
      [opts.empresaId, opts.ipHash, since]
    );
    if (Number(byIp?.c || 0) >= 1) {
      throw new ReviewFraudError(MSG_JA_RECLAMOU, 409);
    }

    const wpp = onlyDigits(opts.clientWhatsapp || '');
    if (wpp.length >= 10) {
      // Compara dígitos: armazenado pode ser 5562... ou variação
      const byWpp = await db.get(
        `SELECT COUNT(*) as c FROM reviews
         WHERE empresa_id = ? AND rating <= 3
           AND COALESCE(is_test,0) = 0 AND createdAt >= ?
           AND client_whatsapp IS NOT NULL
           AND (
             client_whatsapp = ?
             OR replace(replace(replace(client_whatsapp, '+', ''), ' ', ''), '-', '') = ?
           )`,
        [opts.empresaId, since, wpp, wpp]
      );
      if (Number(byWpp?.c || 0) >= 1) {
        throw new ReviewFraudError(MSG_JA_RECLAMOU, 409);
      }
    }
  } catch (e: any) {
    if (e instanceof ReviewFraudError) throw e;
    console.warn('checkOneComplaintOnly:', e?.message || e);
  }
}

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
