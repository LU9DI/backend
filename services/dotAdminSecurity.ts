/**
 * Proteção administrativa do Filtra Dot: PIN + sessão exclusiva.
 *
 * - O PIN é por empresa, cadastrado/redefinido apenas pelo proprietário
 *   verificado da empresa (lib/empresaOwnership). Nunca é armazenado em
 *   claro: hash scrypt (memory-hard) com salt individual, parâmetros
 *   explícitos e comparação em tempo constante.
 * - Tentativas ficam em armazenamento persistente (funciona com múltiplas
 *   instâncias): atraso progressivo e bloqueio temporário por empresa+usuário
 *   — nunca bloqueio permanente, para não permitir indisponibilidade
 *   provocada por terceiros.
 * - A sessão administrativa é um token opaco aleatório (256 bits), validado
 *   no servidor a cada uso, vinculado a empresa+usuário, com expiração curta,
 *   versão do PIN (redefinir o PIN invalida todas as sessões anteriores) e
 *   revogação explícita. Nunca é confundida com o JWT de login e não aceita
 *   troca de usuário/empresa sem nova verificação do PIN.
 * - Operações protegidas exigem também o cabeçalho `X-Dot-Admin: 1`
 *   (proteção CSRF adicional, já que o cookie segue a política de SameSite
 *   adotada pelo restante da API).
 *
 * O PIN nunca aparece em logs, auditoria, mensagens de erro ou telemetria.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import type { Request, Response } from 'express';
import { getDb } from '../lib/db.js';
import { cookieBaseOptions } from '../lib/auth.js';
import { writeAudit } from '../lib/auditLog.js';

export const DOT_ADMIN_COOKIE = 'dot_admin_session';
export const DOT_ADMIN_HEADER = 'x-dot-admin';
export const DOT_ADMIN_HEADER_VALUE = '1';
export const DOT_ADMIN_COOKIE_PATH = '/api/dot';

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

const PIN_DELAYS_MS = [0, 2_000, 5_000, 10_000, 30_000];
const PIN_LOCK_STEPS: Array<{ attempts: number; lockMs: number }> = [
  { attempts: 12, lockMs: 24 * 60 * 60 * 1000 },
  { attempts: 8, lockMs: 60 * 60 * 1000 },
  { attempts: 5, lockMs: 10 * 60 * 1000 },
];

export class DotAdminError extends Error {
  status: number;
  code: string;
  retryAfterMs?: number;
  constructor(message: string, status = 403, code = 'DOT_ADMIN_DENIED', retryAfterMs?: number) {
    super(message);
    this.name = 'DotAdminError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function scryptAsync(password: string, salt: Buffer, keyLen: number, opts: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLen, opts, (err, derived) => (err ? reject(err) : resolve(derived)));
  });
}

function sessionTtlMs(): number {
  const minutes = Number(process.env.DOT_ADMIN_SESSION_TTL_MINUTES || 30);
  const safe = Number.isFinite(minutes) ? Math.min(480, Math.max(5, Math.floor(minutes))) : 30;
  return safe * 60 * 1000;
}

let schemaReady = false;

export async function ensureDotAdminSecuritySchema() {
  if (schemaReady) return;
  const db = getDb();
  await db.exec(`CREATE TABLE IF NOT EXISTS dot_admin_pins (
    empresa_id TEXT PRIMARY KEY,
    pin_hash TEXT NOT NULL,
    hash_algo TEXT NOT NULL DEFAULT 'scrypt',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  )`);
  await db.exec(`CREATE TABLE IF NOT EXISTS dot_admin_pin_attempts (
    empresa_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    failed_count INTEGER NOT NULL DEFAULT 0,
    lock_until TEXT,
    last_failed_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (empresa_id, user_id)
  )`);
  await db.exec(`CREATE TABLE IF NOT EXISTS dot_admin_sessions (
    id TEXT PRIMARY KEY,
    empresa_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    pin_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    revoked_reason TEXT,
    last_used_at TEXT,
    ip TEXT,
    user_agent TEXT
  )`);
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_dot_admin_sessions_scope ON dot_admin_sessions(empresa_id, user_id, revoked_at)',
  );
  schemaReady = true;
}

/** Regras mínimas de formato: 6 dígitos, sem sequências ou repetições óbvias. */
export function validateDotPinFormat(pin: unknown): string | null {
  const value = String(pin ?? '');
  if (!/^\d{6}$/.test(value)) return 'O PIN deve ter exatamente 6 dígitos.';
  if (/^(\d)\1{5}$/.test(value)) return 'Escolha um PIN menos previsível.';
  const digits = value.split('').map(Number);
  const asc = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const desc = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  if (asc || desc) return 'Escolha um PIN menos previsível.';
  return null;
}

export async function hashDotPin(pin: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(pin, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyDotPinHash(stored: string, pin: string): Promise<boolean> {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (!salt.length || !expected.length) return false;
    const derived = await scryptAsync(pin, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM });
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    // Hash corrompido/desconhecido é tratado como inválido (nunca como sucesso).
    return false;
  }
}

export async function getDotAdminPinState(
  empresaId: string,
): Promise<{ configured: boolean; version: number; updated_at: string | null }> {
  await ensureDotAdminSecuritySchema();
  const row = await getDb().get(
    'SELECT version, updated_at FROM dot_admin_pins WHERE empresa_id = ? LIMIT 1',
    [empresaId],
  );
  if (!row) return { configured: false, version: 0, updated_at: null };
  return { configured: true, version: Number(row.version || 1), updated_at: String(row.updated_at || '') };
}

/** Primeiro cadastro do PIN: exclusivo do proprietário e sem sobrescrever um PIN existente. */
export async function setDotAdminPinInitial(
  empresaId: string,
  userId: string,
  pin: string,
  meta?: { ip?: string | null; userAgent?: string | null },
): Promise<{ version: number }> {
  const formatError = validateDotPinFormat(pin);
  if (formatError) throw new DotAdminError(formatError, 400, 'DOT_ADMIN_PIN_FORMAT');
  await ensureDotAdminSecuritySchema();
  const state = await getDotAdminPinState(empresaId);
  if (state.configured) {
    throw new DotAdminError(
      'O PIN administrativo já está configurado. Use a redefinição.',
      409,
      'DOT_ADMIN_PIN_EXISTS',
    );
  }
  const db = getDb();
  const now = new Date().toISOString();
  const hash = await hashDotPin(pin);
  await db.run(
    `INSERT INTO dot_admin_pins (empresa_id, pin_hash, hash_algo, version, created_at, updated_at, updated_by)
     VALUES (?, ?, 'scrypt', 1, ?, ?, ?)`,
    [empresaId, hash, now, now, userId],
  );
  await writeAudit(db, {
    action: 'dot.pin_set',
    actor_user_id: userId,
    empresa_id: empresaId,
    result: 'ok',
    ip: meta?.ip || null,
    user_agent: meta?.userAgent || null,
    detail: { version: 1 },
  });
  return { version: 1 };
}

/**
 * Redefinição autenticada: exige a senha atual da conta do proprietário e
 * invalida TODAS as sessões administrativas anteriores (versão do PIN sobe).
 */
export async function resetDotAdminPin(
  empresaId: string,
  userId: string,
  pin: string,
  senha: string,
  meta?: { ip?: string | null; userAgent?: string | null },
): Promise<{ version: number }> {
  const formatError = validateDotPinFormat(pin);
  if (formatError) throw new DotAdminError(formatError, 400, 'DOT_ADMIN_PIN_FORMAT');
  await ensureDotAdminSecuritySchema();
  const db = getDb();
  const state = await getDotAdminPinState(empresaId);
  if (!state.configured) {
    throw new DotAdminError('O PIN administrativo ainda não foi configurado.', 409, 'DOT_ADMIN_PIN_NOT_SET');
  }
  const usuario = await db.get('SELECT id, senha_hash FROM usuarios WHERE id = ? LIMIT 1', [userId]);
  const senhaOk =
    usuario?.senha_hash && (await bcrypt.compare(String(senha || ''), String(usuario.senha_hash)));
  if (!senhaOk) {
    throw new DotAdminError('Senha atual incorreta.', 403, 'DOT_ADMIN_PASSWORD_MISMATCH');
  }
  const now = new Date().toISOString();
  const hash = await hashDotPin(pin);
  await db.run(
    'UPDATE dot_admin_pins SET pin_hash = ?, hash_algo = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE empresa_id = ?',
    [hash, 'scrypt', now, userId, empresaId],
  );
  const revoked = await revokeAllDotAdminSessionsForEmpresa(empresaId, 'pin_reset');
  await writeAudit(db, {
    action: 'dot.pin_reset',
    actor_user_id: userId,
    empresa_id: empresaId,
    result: 'ok',
    ip: meta?.ip || null,
    user_agent: meta?.userAgent || null,
    detail: { version: state.version + 1, sessions_revoked: revoked },
  });
  return { version: state.version + 1 };
}

function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Verifica o PIN e emite a sessão administrativa.
 * Atraso progressivo nas primeiras falhas; bloqueio temporário (10min/1h/24h)
 * a partir da quinta — nunca permanente. Bloqueio expirado zera o contador.
 */
export async function verifyDotAdminPinForSession(
  empresaId: string,
  userId: string,
  pin: unknown,
  meta?: { ip?: string | null; userAgent?: string | null },
): Promise<{ token: string; id: string; expires_at: string }> {
  await ensureDotAdminSecuritySchema();
  const db = getDb();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const attempts = await db.get(
    'SELECT failed_count, lock_until FROM dot_admin_pin_attempts WHERE empresa_id = ? AND user_id = ? LIMIT 1',
    [empresaId, userId],
  );
  let failed = Number(attempts?.failed_count || 0);
  let lockUntil = attempts?.lock_until ? Date.parse(String(attempts.lock_until)) : 0;
  if (!Number.isFinite(lockUntil)) lockUntil = 0;
  if (lockUntil > nowMs) {
    throw new DotAdminError(
      'Muitas tentativas. Aguarde para tentar novamente.',
      429,
      'DOT_ADMIN_LOCKED',
      lockUntil - nowMs,
    );
  }
  // Atraso progressivo vencido mantém o contador acumulando (a escalada até o
  // bloqueio temporário precisa ser real). Apenas bloqueios longos (>= 5
  // falhas) zeram o histórico ao expirar — nunca há bloqueio permanente.
  if (lockUntil && lockUntil <= nowMs && failed >= 5) failed = 0;

  const pinRow = await db.get('SELECT pin_hash, version FROM dot_admin_pins WHERE empresa_id = ? LIMIT 1', [
    empresaId,
  ]);
  if (!pinRow) {
    throw new DotAdminError('O PIN administrativo ainda não foi configurado.', 409, 'DOT_ADMIN_PIN_NOT_SET');
  }

  const ok = await verifyDotPinHash(String(pinRow.pin_hash), String(pin ?? ''));
  if (!ok) {
    const next = failed + 1;
    const lockStep = PIN_LOCK_STEPS.find((step) => next >= step.attempts);
    const delay = lockStep ? lockStep.lockMs : PIN_DELAYS_MS[Math.min(next, 4)];
    const status = lockStep ? 429 : 403;
    const code = lockStep ? 'DOT_ADMIN_LOCKED' : 'DOT_ADMIN_PIN_INVALID';
    const message = lockStep ? 'Muitas tentativas. Aguarde para tentar novamente.' : 'PIN incorreto.';
    const untilIso = new Date(nowMs + delay).toISOString();

    if (attempts) {
      await db.run(
        'UPDATE dot_admin_pin_attempts SET failed_count = ?, lock_until = ?, last_failed_at = ?, updated_at = ? WHERE empresa_id = ? AND user_id = ?',
        [next, untilIso, nowIso, nowIso, empresaId, userId],
      );
    } else {
      await db.run(
        'INSERT INTO dot_admin_pin_attempts (empresa_id, user_id, failed_count, lock_until, last_failed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [empresaId, userId, next, untilIso, nowIso, nowIso],
      );
    }
    await writeAudit(db, {
      action: 'dot.pin_verify_failed',
      actor_user_id: userId,
      empresa_id: empresaId,
      result: 'denied',
      ip: meta?.ip || null,
      user_agent: meta?.userAgent || null,
      detail: { failures: next, lock_ms: delay },
    });
    throw new DotAdminError(message, status, code, delay);
  }

  await db.run(
    'UPDATE dot_admin_pin_attempts SET failed_count = 0, lock_until = NULL, updated_at = ? WHERE empresa_id = ? AND user_id = ?',
    [nowIso, empresaId, userId],
  );

  const token = crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomUUID();
  const expiresAt = new Date(nowMs + sessionTtlMs()).toISOString();
  await db.run(
    `INSERT INTO dot_admin_sessions
      (id, empresa_id, user_id, token_hash, pin_version, created_at, expires_at, revoked_at, revoked_reason, last_used_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    [
      id,
      empresaId,
      userId,
      hashSessionToken(token),
      Number(pinRow.version || 1),
      nowIso,
      expiresAt,
      nowIso,
      meta?.ip || null,
      meta?.userAgent ? String(meta.userAgent).slice(0, 200) : null,
    ],
  );
  await writeAudit(db, {
    action: 'dot.admin_session_issued',
    actor_user_id: userId,
    empresa_id: empresaId,
    result: 'ok',
    ip: meta?.ip || null,
    user_agent: meta?.userAgent || null,
    detail: { expires_at: expiresAt },
  });
  return { token, id, expires_at: expiresAt };
}

export function readDotAdminCookie(req: Request): string | null {
  const raw = (req as any).cookies?.[DOT_ADMIN_COOKIE];
  return raw && typeof raw === 'string' ? raw : null;
}

/**
 * Sessão válida = token existente, não revogado, não expirado, vinculado à
 * empresa+usuário autenticados e com a versão de PIN vigente.
 */
export async function getActiveDotAdminSession(
  req: Request,
  empresaId: string,
  userId: string,
): Promise<{ id: string; expires_at: string } | null> {
  const token = readDotAdminCookie(req);
  if (!token || !empresaId || !userId) return null;
  await ensureDotAdminSecuritySchema();
  const db = getDb();
  const row = await db.get(
    'SELECT id, empresa_id, user_id, pin_version, expires_at, revoked_at FROM dot_admin_sessions WHERE token_hash = ? LIMIT 1',
    [hashSessionToken(token)],
  );
  if (!row || row.revoked_at) return null;
  if (String(row.empresa_id) !== String(empresaId) || String(row.user_id) !== String(userId)) return null;
  const expires = Date.parse(String(row.expires_at));
  if (!Number.isFinite(expires) || expires <= Date.now()) return null;
  const pin = await db.get('SELECT version FROM dot_admin_pins WHERE empresa_id = ? LIMIT 1', [empresaId]);
  if (!pin || Number(pin.version || 1) !== Number(row.pin_version || 1)) return null;
  return { id: String(row.id), expires_at: String(row.expires_at) };
}

/**
 * Barreira única para operações protegidas: cabeçalho anti-CSRF + sessão
 * administrativa válida. Falhas de banco PROPAGAM (nunca liberam).
 */
export async function requireDotAdminSession(
  req: Request,
  empresaId: string | null | undefined,
  userId: string | null | undefined,
): Promise<{ id: string; expires_at: string }> {
  if (!empresaId || !userId) {
    throw new DotAdminError('Sessão administrativa do Dot necessária.', 403, 'DOT_ADMIN_SESSION_REQUIRED');
  }
  if (String((req.headers as any)?.[DOT_ADMIN_HEADER] || '') !== DOT_ADMIN_HEADER_VALUE) {
    throw new DotAdminError(
      'Cabeçalho X-Dot-Admin: 1 é obrigatório para operações administrativas do Dot.',
      403,
      'DOT_ADMIN_HEADER_REQUIRED',
    );
  }
  const session = await getActiveDotAdminSession(req, empresaId, userId);
  if (!session) {
    throw new DotAdminError(
      'Desbloqueie o Dot com o PIN administrativo para continuar.',
      403,
      'DOT_ADMIN_SESSION_REQUIRED',
    );
  }
  await getDb().run('UPDATE dot_admin_sessions SET last_used_at = ? WHERE id = ?', [
    new Date().toISOString(),
    session.id,
  ]);
  return session;
}

export async function revokeDotAdminSessionByToken(token: string, reason: string): Promise<boolean> {
  if (!token) return false;
  await ensureDotAdminSecuritySchema();
  const row = await getDb().get(
    'SELECT id FROM dot_admin_sessions WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1',
    [hashSessionToken(token)],
  );
  if (!row) return false;
  await getDb().run('UPDATE dot_admin_sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ?', [
    new Date().toISOString(),
    String(reason || 'revoked').slice(0, 60),
    row.id,
  ]);
  return true;
}

export async function revokeAllDotAdminSessionsForEmpresa(empresaId: string, reason: string): Promise<number> {
  await ensureDotAdminSecuritySchema();
  const rows = await getDb().all(
    'SELECT id FROM dot_admin_sessions WHERE empresa_id = ? AND revoked_at IS NULL',
    [empresaId],
  );
  const now = new Date().toISOString();
  for (const row of rows || []) {
    await getDb().run('UPDATE dot_admin_sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ?', [
      now,
      String(reason || 'revoked').slice(0, 60),
      row.id,
    ]);
  }
  return (rows || []).length;
}

export function setDotAdminCookie(res: Response, token: string, expiresAt: string) {
  const maxAge = Math.max(0, Date.parse(expiresAt) - Date.now());
  res.cookie(DOT_ADMIN_COOKIE, token, { ...cookieBaseOptions(), path: DOT_ADMIN_COOKIE_PATH, maxAge });
}

export function clearDotAdminCookie(res: Response) {
  res.clearCookie(DOT_ADMIN_COOKIE, { ...cookieBaseOptions(), path: DOT_ADMIN_COOKIE_PATH });
}
