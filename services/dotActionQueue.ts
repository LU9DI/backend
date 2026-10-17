import { getDb, withDbTransaction } from '../lib/db.js';
import { dotActionRequiresApproval, getDotActionDefinition } from './dotActionRegistry.js';
import { recordDotActionAudit } from './dotActionAudit.js';
import { executeDotActionThroughGateway } from './dotExecutionGateway.js';

export type DotActionStatus = 'prepared' | 'approved' | 'executing' | 'executed' | 'failed' | 'cancelled';

const actionLocks = new Map<string, Promise<void>>();

async function withActionLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = actionLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  actionLocks.set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (actionLocks.get(key) === current) actionLocks.delete(key);
  }
}

function normalizeActionRow(row: any) {
  if (!row) return null;
  return {
    id: Number(row.id ?? row.lastID ?? row.lastInsertRowid),
    decisionId: Number(row.decisionId ?? row.decision_id),
    optionId: String(row.optionId ?? row.option_id),
    action: String(row.action),
    status: String(row.status),
    approvedAt: row.approvedAt ?? row.approved_at ?? null,
    executedAt: row.executedAt ?? row.executed_at ?? null,
    error: row.error ?? null,
  };
}

async function ensureSchema() {
  const db = getDb();
  await db.exec(`CREATE TABLE IF NOT EXISTS dot_action_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id TEXT NOT NULL,
    decision_id INTEGER NOT NULL,
    option_id TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'prepared',
    approved_at TEXT,
    executed_at TEXT,
    error TEXT,
    created_at TEXT NOT NULL
  )`);
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_dot_action_queue_decision_option ON dot_action_queue(empresa_id, decision_id, option_id)');
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_dot_action_queue_one_active_decision ON dot_action_queue(empresa_id, decision_id) WHERE status IN ('prepared','approved','executing')");
}

export async function prepareDotActionFromDecision(empresaId: string, decisionId: number, optionId: string) {
  await ensureSchema();
  const prepared = await withActionLock(`prepare:${empresaId}:${decisionId}`, () =>
    withDbTransaction(async (tx) => {
      const decision = await tx.get('SELECT * FROM dot_decisions WHERE id = ? AND empresa_id = ? LIMIT 1', [decisionId, empresaId]);
      if (!decision) return null;

      const decisionStatus = String(decision.status || '');
      if (!['pending', 'prepared'].includes(decisionStatus)) return null;
      if (Number(decision.requires_approval) !== 1) return null;

      let options: any[];
      try {
        options = JSON.parse(decision.options_json || '[]');
      } catch {
        return null;
      }
      const option = options.find((item: any) => item?.id === optionId);
      if (!option) return null;
      const definition = getDotActionDefinition(String(option.action));
      if (!definition || !dotActionRequiresApproval(definition.action)) return null;

      const existing = await tx.get(
        "SELECT * FROM dot_action_queue WHERE empresa_id = ? AND decision_id = ? AND status IN ('prepared','approved','executing') LIMIT 1",
        [empresaId, decisionId],
      );
      if (existing) return normalizeActionRow(existing);

      // `run` não devolve o id em Postgres (o adapter descarta RETURNING);
      // reler pela chave (empresa, decisão, opção) dentro da mesma transação
      // mantém a criação atômica nos dois engines. O cast cobre a API sqlite
      // ({changes, lastID}) e a Postgres ({lastID} derivado de RETURNING id).
      const result = (await tx.run(
        'INSERT INTO dot_action_queue (empresa_id,decision_id,option_id,action,status,created_at) VALUES (?,?,?,?,?,?) RETURNING id',
        [empresaId, decisionId, option.id, definition.action, 'prepared', new Date().toISOString()],
      )) as unknown as { changes: number; lastID?: number | bigint; lastInsertRowid?: number | bigint; id?: number | bigint };
      let id = Number(result.lastID ?? result.lastInsertRowid ?? result.id);
      if (!Number.isInteger(id) || id <= 0) {
        const inserted = await tx.get(
          'SELECT id FROM dot_action_queue WHERE empresa_id = ? AND decision_id = ? AND option_id = ? LIMIT 1',
          [empresaId, decisionId, option.id],
        );
        id = Number(inserted?.id);
      }
      if (!Number.isInteger(id) || id <= 0) throw new Error('A fila de ação não retornou um identificador válido.');

      if (decisionStatus === 'pending') {
        const promoted = await tx.run(
          "UPDATE dot_decisions SET status = 'prepared' WHERE id = ? AND empresa_id = ? AND status = 'pending'",
          [decisionId, empresaId],
        );
        if (promoted.changes !== 1) throw new Error('Não foi possível preparar a decisão; transação revertida.');
      }
      return normalizeActionRow({ id, decision_id: decisionId, option_id: option.id, action: definition.action, status: 'prepared' });
    }),
  );

  if (prepared?.id) {
    await recordDotActionAudit({
      empresaId,
      actionId: Number(prepared.id),
      decisionId,
      event: 'prepared',
      actorType: 'dot',
      metadata: { optionId: prepared.optionId },
    });
  }
  return prepared;
}

export async function approveDotAction(empresaId: string, actionId: number) {
  await ensureSchema();
  const now = new Date().toISOString();

  const approved = await withActionLock(`approve:${empresaId}:${actionId}`, () =>
    withDbTransaction(async (tx) => {
      const action = await tx.get(
        "SELECT id, decision_id, option_id, action FROM dot_action_queue WHERE id = ? AND empresa_id = ? AND status = 'prepared' LIMIT 1",
        [actionId, empresaId],
      );
      if (!action) return null;

      const decision = await tx.get(
        'SELECT id, status, requires_approval FROM dot_decisions WHERE id = ? AND empresa_id = ? LIMIT 1',
        [action.decision_id, empresaId],
      );
      if (!decision || String(decision.status) !== 'prepared' || Number(decision.requires_approval) !== 1) return null;

      const decisionApproved = await tx.run(
        "UPDATE dot_decisions SET status = 'approved' WHERE id = ? AND empresa_id = ? AND status = 'prepared' AND requires_approval = 1",
        [action.decision_id, empresaId],
      );
      if (decisionApproved.changes !== 1) return null;

      const updated = await tx.run(
        "UPDATE dot_action_queue SET status = ?, approved_at = ? WHERE id = ? AND empresa_id = ? AND status = 'prepared'",
        ['approved', now, actionId, empresaId],
      );
      if (!updated || updated.changes !== 1) throw new Error('Não foi possível consumir a ação preparada; transação revertida.');

      return {
        id: Number(action.id),
        decisionId: Number(action.decision_id),
        optionId: String(action.option_id),
        action: String(action.action),
        status: 'approved',
        executed: false,
      };
    }),
  );

  if (approved?.id) {
    await recordDotActionAudit({ empresaId, actionId, decisionId: Number(approved.decisionId), event: 'approved', actorType: 'user' });
  }
  return approved;
}

export async function listDotActions(empresaId: string) {
  await ensureSchema();
  const rows = await getDb().all('SELECT * FROM dot_action_queue WHERE empresa_id = ? ORDER BY id DESC LIMIT 50', [empresaId]);
  return (rows || []).map(normalizeActionRow);
}

export async function executeDotAction(empresaId: string, actionId: number, actorUserId?: string | null) {
  await ensureSchema();
  return executeDotActionThroughGateway(empresaId, actionId, actorUserId || null);
}
