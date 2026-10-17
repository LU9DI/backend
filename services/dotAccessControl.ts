import { getDb } from '../lib/db.js';

export type DotAccessAction = 'read' | 'analyze' | 'create' | 'update' | 'execute' | 'external_send';
export type DotAccessResource = 'filtra' | 'customers' | 'sales' | 'marketing' | 'operations' | 'finance' | 'hr' | 'crm' | 'documents' | 'calendar' | 'email' | 'whatsapp' | 'erp' | 'other';
export type DotPermission = { resource: DotAccessResource; action: DotAccessAction; granted: boolean; granted_by?: string | null; granted_at?: string | null };

export async function ensureDotAccessSchema() {
  const db = getDb();
  await db.exec(`CREATE TABLE IF NOT EXISTS dot_agent_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id TEXT NOT NULL, user_id TEXT, resource TEXT NOT NULL,
    action TEXT NOT NULL, granted INTEGER NOT NULL DEFAULT 0, granted_by TEXT, granted_at TEXT,
    revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_dot_permissions_empresa ON dot_agent_permissions(empresa_id, resource, action)');
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_dot_permissions_scope ON dot_agent_permissions(empresa_id, COALESCE(user_id, ''), resource, action)");
  await db.exec(`CREATE TABLE IF NOT EXISTS dot_access_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id TEXT NOT NULL, user_id TEXT, resource TEXT NOT NULL,
    action TEXT NOT NULL, allowed INTEGER NOT NULL, reason TEXT NOT NULL, context TEXT, created_at TEXT NOT NULL
  )`);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_dot_access_audit_empresa ON dot_access_audit(empresa_id, created_at)');
}

const internalBaseline: Array<{ resource: DotAccessResource; action: DotAccessAction }> = [
  { resource: 'filtra', action: 'read' },
  { resource: 'filtra', action: 'analyze' },
  { resource: 'filtra', action: 'create' },
  { resource: 'filtra', action: 'update' },
  { resource: 'filtra', action: 'execute' },
  { resource: 'operations', action: 'read' },
  { resource: 'operations', action: 'update' },
  { resource: 'operations', action: 'execute' },
];
const internalBaselineReady = new Set<string>();

/**
 * Permite o núcleo interno do DOT sem exigir configuração manual inicial.
 * Não concede CRM, e-mail, WhatsApp, envio externo ou qualquer conector externo.
 * Conflitos são ignorados para preservar revogações explícitas feitas pelo cliente.
 */
export async function ensureDotInternalPermissionBaseline(empresaId: string) {
  if (!empresaId || internalBaselineReady.has(empresaId)) return;
  await ensureDotAccessSchema();
  const db = getDb();
  const now = new Date().toISOString();
  for (const permission of internalBaseline) {
    await db.run(
      `INSERT INTO dot_agent_permissions
        (empresa_id,user_id,resource,action,granted,granted_by,granted_at,revoked_at,created_at,updated_at)
        VALUES (?,NULL,?,?,1,NULL,?,NULL,?,?)
        ON CONFLICT DO NOTHING`,
      [empresaId, permission.resource, permission.action, now, now, now],
    );
  }
  internalBaselineReady.add(empresaId);
}

export async function listDotPermissions(empresaId: string, userId?: string | null) {
  await ensureDotAccessSchema();
  return getDb().all(
    `SELECT resource, action, granted, granted_by, granted_at, revoked_at
       FROM dot_agent_permissions WHERE empresa_id = ? AND (user_id IS NULL OR user_id = ?)
       ORDER BY resource, action`, [empresaId, userId || null],
  );
}

async function auditChange(empresaId: string, actorUserId: string, targetUserId: string | null, resource: string, action: string, granted: boolean) {
  await ensureDotAccessSchema();
  await getDb().run(
    'INSERT INTO dot_access_audit (empresa_id,user_id,resource,action,allowed,reason,context,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [empresaId, actorUserId, resource, action, 1, granted ? 'permission_granted' : 'permission_revoked', JSON.stringify({ targetUserId }).slice(0, 8000), new Date().toISOString()],
  );
}

export async function setDotPermission(
  empresaId: string,
  input: { resource: DotAccessResource; action: DotAccessAction; granted: boolean; userId?: string | null; grantedBy?: string | null },
) {
  await ensureDotAccessSchema();
  if (!input.grantedBy) throw new Error('Responsável autenticado é obrigatório para alterar permissões.');
  // A identidade que concede a permissão não pode ser omitida nem forjada pelo cliente.
  // O alvo continua sendo a empresa inteira (null) ou um usuário específico.
  const db = getDb();
  const userId = input.userId || null;
  const now = new Date().toISOString();
  // `? IS NULL` não tem tipo inferível no Postgres ("could not determine data
  // type of parameter"); o ramo por userId é equivalente e roda nos dois engines.
  const existing = userId == null
    ? await db.get(
        `SELECT id FROM dot_agent_permissions
          WHERE empresa_id = ? AND resource = ? AND action = ? AND user_id IS NULL LIMIT 1`,
        [empresaId, input.resource, input.action],
      )
    : await db.get(
        `SELECT id FROM dot_agent_permissions
          WHERE empresa_id = ? AND resource = ? AND action = ? AND user_id = ? LIMIT 1`,
        [empresaId, input.resource, input.action, userId],
      );
  if (existing) {
    await db.run(
      `UPDATE dot_agent_permissions SET granted=?, granted_by=?,
        granted_at=CASE WHEN ?=1 THEN ? ELSE granted_at END,
        revoked_at=CASE WHEN ?=1 THEN NULL ELSE ? END, updated_at=? WHERE id=?`,
      [input.granted ? 1 : 0, input.grantedBy, input.granted ? 1 : 0, now, input.granted ? 1 : 0, now, now, existing.id],
    );
  } else {
    await db.run(
      `INSERT INTO dot_agent_permissions
       (empresa_id,user_id,resource,action,granted,granted_by,granted_at,revoked_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [empresaId, userId, input.resource, input.action, input.granted ? 1 : 0, input.grantedBy, input.granted ? now : null, input.granted ? null : now, now, now],
    );
  }
  await auditChange(empresaId, input.grantedBy, userId, input.resource, input.action, input.granted);
  return userId == null
    ? db.get(
        `SELECT resource, action, granted, granted_by, granted_at, revoked_at FROM dot_agent_permissions
          WHERE empresa_id=? AND resource=? AND action=? AND user_id IS NULL LIMIT 1`,
        [empresaId, input.resource, input.action],
      )
    : db.get(
        `SELECT resource, action, granted, granted_by, granted_at, revoked_at FROM dot_agent_permissions
          WHERE empresa_id=? AND resource=? AND action=? AND user_id=? LIMIT 1`,
        [empresaId, input.resource, input.action, userId],
      );
}

async function recordAccess(empresaId: string, userId: string | null | undefined, resource: string, action: string, allowed: boolean, reason: string, context?: unknown) {
  await ensureDotAccessSchema();
  await getDb().run(
    'INSERT INTO dot_access_audit (empresa_id,user_id,resource,action,allowed,reason,context,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [empresaId, userId || null, resource, action, allowed ? 1 : 0, reason, context ? JSON.stringify(context).slice(0, 8000) : null, new Date().toISOString()],
  );
}

/**
 * Uma linha de permissão só vale se estiver concedida e não revogada.
 * Exportado para testes e para o registro de políticas do DOT.
 */
export function isDotPermissionActive(row: { granted?: unknown; revoked_at?: unknown } | null | undefined): boolean {
  return Boolean(row && Number(row.granted) === 1 && !row.revoked_at);
}

export async function dotAccessAllowed(empresaId: string, resource: DotAccessResource, action: DotAccessAction, userId?: string | null, context?: unknown) {
  await ensureDotAccessSchema();
  const db = getDb();
  // Resolve a linha MAIS ESPECÍFICA primeiro — inclusive negativas explícitas.
  // Filtrar granted=1 antes da ordenação deixaria uma concessão da empresa
  // sobrepor uma revogação individual feita pelo cliente.
  const row = await db.get(
    `SELECT granted, revoked_at FROM dot_agent_permissions
      WHERE empresa_id=? AND resource=? AND action=? AND (user_id IS NULL OR user_id=?)
        ORDER BY CASE WHEN user_id=? THEN 0 ELSE 1 END LIMIT 1`,
    [empresaId, resource, action, userId || null, userId || null],
  );
  const allowed = isDotPermissionActive(row);
  await recordAccess(empresaId, userId, resource, action, allowed, allowed ? 'permission_granted' : 'permission_denied', context);
  return allowed;
}

export async function requireDotAccess(empresaId: string, resource: DotAccessResource, action: DotAccessAction, userId?: string | null, context?: unknown) {
  const allowed = await dotAccessAllowed(empresaId, resource, action, userId, context);
  if (!allowed) {
    const error = new Error(`DOT sem permissão: ${resource}.${action}`);
    (error as any).code = 'DOT_PERMISSION_REQUIRED';
    (error as any).resource = resource;
    (error as any).action = action;
    throw error;
  }
}
