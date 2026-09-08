/**
 * Helpers de segurança: senha forte, máscara PII, URLs, CORS.
 */

const APP_HOSTS = new Set(
  [
    'filtraai.com',
    'www.filtraai.com',
    'api.filtraai.com',
    'localhost',
    '127.0.0.1',
  ].map((h) => h.toLowerCase())
);

export function maskEmail(email?: string | null): string {
  if (!email || !email.includes('@')) return '***';
  const [u, d] = email.split('@');
  if (!d) return '***';
  const user = u.length <= 2 ? '*'.repeat(u.length) : u[0] + '***' + u[u.length - 1];
  const parts = d.split('.');
  const dom = parts[0] ? parts[0][0] + '***' : '***';
  const tld = parts.slice(1).join('.') || '***';
  return `${user}@${dom}.${tld}`;
}

export function maskToken(t?: string | null): string {
  if (!t) return '';
  if (t.length < 12) return '***';
  return t.slice(0, 4) + '…' + t.slice(-4);
}

/** Senha: mín. 12 chars, maiúscula, minúscula, número, símbolo. */
export function validateStrongPassword(password: string): {
  ok: boolean;
  error?: string;
} {
  const p = String(password || '');
  if (p.length < 12) {
    return { ok: false, error: 'Senha deve ter no mínimo 12 caracteres.' };
  }
  if (!/[a-z]/.test(p)) {
    return { ok: false, error: 'Senha precisa de letra minúscula.' };
  }
  if (!/[A-Z]/.test(p)) {
    return { ok: false, error: 'Senha precisa de letra maiúscula.' };
  }
  if (!/[0-9]/.test(p)) {
    return { ok: false, error: 'Senha precisa de número.' };
  }
  if (!/[^A-Za-z0-9]/.test(p)) {
    return { ok: false, error: 'Senha precisa de símbolo (ex: !@#$).' };
  }
  return { ok: true };
}

export function isAllowedAppUrl(raw?: string | null): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
      return false;
    }
    const host = u.hostname.toLowerCase();
    if (APP_HOSTS.has(host)) return true;
    // permite subdomínios de filtraai.com
    if (host.endsWith('.filtraai.com')) return true;
    // hosts extras via env
    const extra = (process.env.ALLOWED_APP_HOSTS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return extra.includes(host);
  } catch {
    return false;
  }
}

/** Monta URL segura sem open-redirect. */
export function safeAppUrl(path = '/'): string {
  const base =
    process.env.APP_URL ||
    process.env.FRONTEND_URL ||
    'https://filtraai.com';
  const baseOk = isAllowedAppUrl(base) ? base : 'https://filtraai.com';
  try {
    return new URL(path.startsWith('/') ? path : `/${path}`, baseOk.replace(/\/$/, '') + '/').toString();
  } catch {
    return 'https://filtraai.com/';
  }
}

export function safeLog(msg: string, extra?: Record<string, unknown>) {
  if (process.env.NODE_ENV === 'production' && process.env.DEBUG_LOGS !== '1') {
    // silencia ruído em produção salvo erros
    return;
  }
  if (extra) console.log(msg, extra);
  else console.log(msg);
}
