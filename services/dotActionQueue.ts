import { dbEngine, getDb, withDbTransaction } from '../lib/db.js';
import { requireSchema } from '../lib/migrations.js';
import { dotActionRequiresApproval, getDotActionDefinition } from './dotActionRegistry.js';
import { ensureDotActionAuditSchema } from './dotActionAudit.js';
import { executeDotActionThroughGateway } from './dotExecutionGateway.js';

export type DotActionStatus = 'prepared' | 'approved' | 'executing' | 'executed' | 'failed' | 'cancelled';

export class DotActionOptionConflictError extends Error {
  readonly code = 'DOT_ACTION_OPTION_CONFLICT';

  constructor(
    readonly existingOptionId: string,
    readonly requestedOptionId: string,
  ) {
    super('Já existe uma ação ativa para esta decisão com outra opção. Atualize a decisão antes de tentar novamente.');
    this.name = 'DotActionOptionConflictError';
  }
}

/**
 * Separação de funções: quem preparou não pode aprovar, exceto o owner
 * autoritativo da empresa (tabela `empresa_owners`), com exceção auditada.
 */
export class DotApprovalSeparationError extends Error {
  readonly code = 'DOT_SEPARATION_OF_DUTIES';
  readonly status = 403;

  constructor() {
    super(
      'A aprovação deve ser feita por um usuário diferente do preparador. ' +
        'O owner da empresa pode aprovar a própria preparação como exceção auditada.',
    );
    this.name = 'DotApprovalSeparationError';
  }
}

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

/**
 * Verifica o schema da fila de ações — sem DDL em caminho de requisição.
 * Tabela/índices são criados apenas em `runCentralMigrations`.
 */
export async function ensureDotActionSchema() {
  const db = getDb();
  await requireSchema(db, {
    tables: ['dot_action_queue'],
    columns: {
      dot_action_queue: [
        'id',
        'empresa_id',
        'decision_id',
        'option_id',
        'action',
        'status',
        'approved_at',
        'executed_at',
        'error',
        'created_at',
      ],
    },
    indexes: [
      { table: 'dot_action_queue', name: 'ux_dot_action_queue_decision_option' },
      { table: 'dot_action_queue', name: 'ux_dot_action_queue_one_active_decision' },
    ],
  });
}

export async function prepareDotActionFromDecision(
  empresaId: string,
  decisionId: number,
  optionId: string,
  actorUserId?: string | null,
) {
  await ensureDotActionSchema();
  await ensureDotActionAuditSchema();
  const prepared = await withActionLock(`prepare:${empresaId}:${decisionId}`, () =>
    withDbTransaction(async (tx) => {
      const decisionLock = dbEngine() === 'postgres' ? ' FOR UPDATE' : '';
      const decision = await tx.get(`SELECT * FROM dot_decisions WHERE id = ? AND empresa_id = ? LIMIT 1${decisionLock}`, [decisionId, empresaId]);
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
      if (existing) {
        const existingOptionId = String(existing.option_id ?? existing.optionId ?? '');
        if (existingOptionId !== String(option.id)) {
          throw new DotActionOptionConflictError(existingOptionId, String(option.id));
        }
        return normalizeActionRow(existing);
      }

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
      // O evento 'prepared' participa da MESMA transação da criação da ação:
      //  - a ação preparada nunca existe sem a trilha de auditoria (falha na
      //    auditoria reverte a preparação);
      //  - um ator autenticado que pediu a preparação é registrado como
      //    `user`; apenas chamadas do próprio Dot (monitor/scheduler) ficam
      //    como `dot`, sem ator;
      //  - o caminho de deduplicação (`existing`, acima) NÃO grava auditoria
      //    nova: repetir a preparação não inventa uma segunda transição.
      await tx.run(
        `INSERT INTO dot_action_audit
          (empresa_id, action_id, decision_id, event, actor_type, actor_id, metadata, created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
        [
          empresaId,
          id,
          decisionId,
          'prepared',
          actorUserId ? 'user' : 'dot',
          actorUserId || null,
          JSON.stringify({ optionId: option.id }).slice(0, 12000),
          new Date().toISOString(),
        ],
      );

      return normalizeActionRow({ id, decision_id: decisionId, option_id: option.id, action: definition.action, status: 'prepared' });
    }),
  );

  return prepared;
}

export async function approveDotAction(empresaId: string, actionId: number, actorUserId?: string | null) {
  await ensureDotActionSchema();
  await ensureDotActionAuditSchema();
  const now = new Date().toISOString();

  const approved = await withActionLock(`approve:${empresaId}:${actionId}`, () =>
    withDbTransaction(async (tx) => {
      const action = await tx.get(
        `SELECT id, decision_id, option_id, action FROM dot_action_queue WHERE id = ? AND empresa_id = ? AND status = 'prepared' LIMIT 1${dbEngine() === 'postgres' ? ' FOR UPDATE' : ''}`,
        [actionId, empresaId],
      );
      if (!action) return null;

      const decision = await tx.get(
        `SELECT id, status, requires_approval FROM dot_decisions WHERE id = ? AND empresa_id = ? LIMIT 1${dbEngine() === 'postgres' ? ' FOR UPDATE' : ''}`,
        [action.decision_id, empresaId],
      );
      if (!decision || String(decision.status) !== 'prepared' || Number(decision.requires_approval) !== 1) return null;

      // Separação de funções: identifica o preparador pela trilha auditável,
      // nunca por campo do cliente. A exceção de owner é verificada na tabela
      // autoritativa `empresa_owners`, dentro da mesma transação.
      const preparer = await tx.get(
        `SELECT actor_type, actor_id FROM dot_action_audit
          WHERE empresa_id = ? AND action_id = ? AND event = 'prepared'
          ORDER BY id DESC LIMIT 1`,
        [empresaId, actionId],
      );
      const preparerType = String(preparer?.actor_type || '');
      const preparerId = preparer?.actor_id ? String(preparer.actor_id) : null;
      let separationDecision: 'distinct_actors' | 'owner_override' | 'no_preparer_recorded' | 'internal_actor' =
        'no_preparer_recorded';
      let ownerOverride = false;

      if (preparer && preparerType === 'dot') {
        // Preparação automática do monitor/scheduler: não há usuário preparador.
        separationDecision = 'internal_actor';
      } else if (preparerId) {
        if (actorUserId && String(actorUserId) === preparerId) {
          let ownerUserId: string | null = null;
          try {
            const owner = await tx.get(
              'SELECT user_id FROM empresa_owners WHERE empresa_id = ? LIMIT 1',
              [empresaId],
            );
            ownerUserId = owner?.user_id ? String(owner.user_id) : null;
          } catch {
            // Sem tabela de owners: sem exceção possível (fail-closed).
            ownerUserId = null;
          }
          if (!ownerUserId || ownerUserId !== String(actorUserId)) {
            throw new DotApprovalSeparationError();
          }
          separationDecision = 'owner_override';
          ownerOverride = true;
        } else {
          separationDecision = 'distinct_actors';
        }
      }

      const separationMetadata = {
        separation_decision: separationDecision,
        owner_override: ownerOverride,
        preparer_id: preparerId,
        preparer_actor_type: preparerType || null,
        approver_id: actorUserId || null,
      };

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

      // O evento de auditoria participa da mesma transação da aprovação.
      // Se a gravação falhar, a mudança de status também será revertida.
      await tx.run(
        `INSERT INTO dot_action_audit
          (empresa_id, action_id, decision_id, event, actor_type, actor_id, metadata, created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
        [empresaId, actionId, Number(action.decision_id), 'approved', 'user', actorUserId || null, JSON.stringify(separationMetadata).slice(0, 12000), now],
      );

      return {
        id: Number(action.id),
        decisionId: Number(action.decision_id),
        optionId: String(action.option_id),
        action: String(action.action),
        status: 'approved',
        executed: false,
        separation: separationDecision,
        ownerOverride,
      };
    }),
  );

  return approved;
}

export async function listDotActions(empresaId: string) {
  await ensureDotActionSchema();
  const rows = await getDb().all('SELECT * FROM dot_action_queue WHERE empresa_id = ? ORDER BY id DESC LIMIT 50', [empresaId]);
  return (rows || []).map(normalizeActionRow);
}

export async function executeDotAction(empresaId: string, actionId: number, actorUserId?: string | null) {
  await ensureDotActionSchema();
  return executeDotActionThroughGateway(empresaId, actionId, actorUserId || null);
}
