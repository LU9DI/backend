/**
 * Logs de auditoria (append-only).
 * Quem fez o quê, quando, em qual empresa, com resultado.
 */
import type { Database } from 'sqlite';
import type { Request } from 'express';

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'plan.change'
  | 'billing.activate'
  | 'billing.block'
  | 'empresa.whatsapp'
  | 'empresa.google'
  | 'relatorio.download'
  | 'unidade.create'
  | 'unidade.delete'
  | 'webauthn.register'
  | 'admin.action'
  | string;

export async function ensureAuditSchema(db: Database) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      actor_user_id TEXT,
      actor_role TEXT,
      empresa_id TEXT,
      action TEXT NOT NULL,
      target TEXT,
      result TEXT NOT NULL DEFAULT 'ok',
      ip TEXT,
      user_agent TEXT,
      detail TEXT
    );
  `);
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC)`
  );
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_audit_empresa ON audit_logs(empresa_id)`
  );
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action)`
  );
}

export function clientIp(req?: Request | null): string | null {
  if (!req) return null;
  const xf = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return xf || req.socket?.remoteAddress || null;
}

export async function writeAudit(
  db: Database,
  opts: {
    action: AuditAction;
    actor_user_id?: string | null;
    actor_role?: string | null;
    empresa_id?: string | null;
    target?: string | null;
    result?: 'ok' | 'error' | 'denied';
    ip?: string | null;
    user_agent?: string | null;
    detail?: string | Record<string, unknown> | null;
  }
) {
  try {
    await ensureAuditSchema(db);
    const detail =
      opts.detail == null
        ? null
        : typeof opts.detail === 'string'
          ? opts.detail.slice(0, 1000)
          : JSON.stringify(opts.detail).slice(0, 1000);

    await db.run(
      `INSERT INTO audit_logs
        (actor_user_id, actor_role, empresa_id, action, target, result, ip, user_agent, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        opts.actor_user_id || null,
        opts.actor_role || null,
        opts.empresa_id || null,
        String(opts.action).slice(0, 80),
        opts.target ? String(opts.target).slice(0, 200) : null,
        opts.result || 'ok',
        opts.ip ? String(opts.ip).slice(0, 80) : null,
        opts.user_agent ? String(opts.user_agent).slice(0, 200) : null,
        detail,
      ]
    );
  } catch (e: any) {
    console.warn('[audit]', e?.message || e);
  }
}

export async function writeAuditFromReq(
  db: Database,
  req: Request,
  opts: Omit<Parameters<typeof writeAudit>[1], 'ip' | 'user_agent'> & {
    ip?: string | null;
    user_agent?: string | null;
  }
) {
  return writeAudit(db, {
    ...opts,
    ip: opts.ip ?? clientIp(req),
    user_agent: opts.user_agent ?? String(req.headers['user-agent'] || '').slice(0, 200),
  });
}

export async function listAuditLogs(
  db: Database,
  opts?: { limit?: number; empresa_id?: string; action?: string }
) {
  await ensureAuditSchema(db);
  const limit = Math.min(200, Math.max(1, opts?.limit || 50));
  if (opts?.empresa_id && opts?.action) {
    return db.all(
      `SELECT * FROM audit_logs WHERE empresa_id = ? AND action = ? ORDER BY id DESC LIMIT ?`,
      [opts.empresa_id, opts.action, limit]
    );
  }
  if (opts?.empresa_id) {
    return db.all(
      `SELECT * FROM audit_logs WHERE empresa_id = ? ORDER BY id DESC LIMIT ?`,
      [opts.empresa_id, limit]
    );
  }
  if (opts?.action) {
    return db.all(
      `SELECT * FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT ?`,
      [opts.action, limit]
    );
  }
  return db.all(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?`, [limit]);
}
