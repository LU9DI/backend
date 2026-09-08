/**
 * Proteção anti brute-force por identidade (CNPJ/e-mail) + IP.
 * Em memória (por instância Render). Suficiente para single-instance.
 */

type Bucket = {
  fails: number;
  lockedUntil: number;
  lastFail: number;
};

const byKey = new Map<string, Bucket>();

const MAX_FAILS = Math.max(3, Number(process.env.LOGIN_MAX_FAILS || 5));
const LOCK_MS = Math.max(60_000, Number(process.env.LOGIN_LOCK_MS || 15 * 60 * 1000));
const WINDOW_MS = Math.max(60_000, Number(process.env.LOGIN_FAIL_WINDOW_MS || 15 * 60 * 1000));

function now() {
  return Date.now();
}

function get(key: string): Bucket {
  let b = byKey.get(key);
  if (!b) {
    b = { fails: 0, lockedUntil: 0, lastFail: 0 };
    byKey.set(key, b);
  }
  // janela expirada → zera falhas
  if (b.fails > 0 && now() - b.lastFail > WINDOW_MS && now() > b.lockedUntil) {
    b.fails = 0;
  }
  return b;
}

export function assertNotLocked(identity: string, ip?: string): void {
  const keys = [identity.toLowerCase()];
  if (ip) keys.push(`ip:${ip}`);
  for (const k of keys) {
    const b = get(k);
    if (b.lockedUntil > now()) {
      const min = Math.ceil((b.lockedUntil - now()) / 60000);
      const err: any = new Error(
        `Muitas tentativas. Conta temporariamente bloqueada. Tente em ~${min} min.`
      );
      err.status = 429;
      throw err;
    }
  }
}

export function recordLoginFail(identity: string, ip?: string): void {
  const keys = [identity.toLowerCase()];
  if (ip) keys.push(`ip:${ip}`);
  for (const k of keys) {
    const b = get(k);
    b.fails += 1;
    b.lastFail = now();
    if (b.fails >= MAX_FAILS) {
      b.lockedUntil = now() + LOCK_MS;
      console.warn(`[loginGuard] lock ${k.slice(0, 24)}… fails=${b.fails}`);
    }
  }
}

export function recordLoginSuccess(identity: string, ip?: string): void {
  byKey.delete(identity.toLowerCase());
  if (ip) {
    const b = byKey.get(`ip:${ip}`);
    if (b) {
      b.fails = Math.max(0, b.fails - 1);
      if (b.fails === 0) byKey.delete(`ip:${ip}`);
    }
  }
}

/** Atraso artificial crescente (ms) após falhas — dificulta brute-force. */
export function failDelayMs(identity: string): number {
  const b = get(identity.toLowerCase());
  if (b.fails <= 1) return 0;
  return Math.min(3000, 250 * b.fails);
}

export function loginGuardStats() {
  return { keys: byKey.size, maxFails: MAX_FAILS, lockMs: LOCK_MS };
}
