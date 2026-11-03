import { dbEngine, getDb, withDbTransaction } from '../lib/db.js';
import { requireSchema } from '../lib/migrations.js';
import type { Database } from 'sqlite';
import { dotActionRequiresApproval, getDotActionDefinition } from './dotActionRegistry.js';
import { ensureDotActionAuditSchema } from './dotActionAudit.js';
import { executeDotActionThroughGateway } from './dotExecutionGateway.js';
import { dotActorAuditColumns, resolveDotActor, type DotActor } from './dotActor.js';

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

  constructor(
    message = 'A aprovação deve ser feita por um usuário diferente do preparador. ' +
      'O owner da empresa pode aprovar a própria preparação como exceção auditada.',
  ) {
    super(message);
    this.name = 'DotApprovalSeparationError';
  }
}

/**
 * Marcador único aceito para compatibilidade histórica. Uma ação sem evento
 * `prepared` só é aprovada se existir, para o par (empresa, ação), uma linha
 * EXPLÍCITA com este marcador na tabela `dot_action_legacy_approval_markers`.
 * O código nunca insere esse marcador: ele é criado por operação
 * administrativa deliberada e auditável.
 */
export const DOT_LEGACY_NO_PREPARER_MARKER = 'no_preparer_recorded_v1';

type LegacyApprovalMarker = { marker: string; reason: string | null };

/**
 * Verifica o marcador restrito de migração. Ausência de tabela ou de linha
 * significa ausência de exceção (fail-closed): a aprovação é bloqueada.
 */
async function findLegacyApprovalMarker(
  db: Database,
  empresaId: string,
  actionId: number,
): Promise<LegacyApprovalMarker | null> {
  try {
    const row: any = await db.get(
      `SELECT marker, reason FROM dot_action_legacy_approval_markers
        WHERE empresa_id = ? AND action_id = ? AND marker = ? LIMIT 1`,
      [empresaId, actionId, DOT_LEGACY_NO_PREPARER_MARKER],
    );
    if (!row) return null;
    return { marker: String(row.marker), reason: row.reason ? String(row.reason) : null };
  } catch {
    // Tabela ausente em banco legado: sem marcador verificável, sem exceção.
    return null;
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

/**
 * Aprova uma ação preparada.
 *
 * Identidade é EXPLÍCITA e obrigatória (`DotActor`): usuário autenticado com
 * ID, ou ator interno autorizado com origem declarada. Chamada sem ator válido
 * é rejeitada ANTES da transação — sem alterar decisão, fila ou auditoria.
 *
 * A ausência do evento `prepared` BLOQUEIA a aprovação. A única exceção é um
 * marcador explícito, verificável e restrito de migração por (empresa, ação).
 */
export async function approveDotAction(
  empresaId: string,
  actionId: number,
  actor: DotActor | null | undefined,
) {
  // Resolve/valida o ator antes de qualquer escrita: identidade ausente ou
  // inválida não pode produzir efeito nem auditoria de aprovação.
  const approver = resolveDotActor(actor);
  const approverAudit = dotActorAuditColumns(approver);

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
      const preparerType = preparer ? String(preparer.actor_type || '').trim().toLowerCase() : null;
      const rawPreparerId = preparer?.actor_id;
      const preparerId =
        typeof rawPreparerId === 'string' && rawPreparerId.trim().length > 0
          ? rawPreparerId.trim()
          : null;

      let separationDecision: 'distinct_actors' | 'owner_override' | 'no_preparer_recorded' | 'internal_actor';
      let ownerOverride = false;
      let legacyMarker: LegacyApprovalMarker | null = null;

      if (!preparer) {
        // Requisito de segurança: sem evento `prepared`, a aprovação é
        // bloqueada. Não se presume preparação pelo Dot a partir da ausência
        // de auditoria. Compatibilidade histórica só com marcador explícito,
        // verificável e restrito (empresa, ação) — nunca inferida.
        legacyMarker = await findLegacyApprovalMarker(tx, empresaId, actionId);
        if (!legacyMarker) {
          throw new DotApprovalSeparationError(
            'Não há evento de preparação auditado para esta ação; a aprovação está bloqueada. ' +
              'Compatibilidade histórica exige marcador explícito de migração.',
          );
        }
        // Ação legada aprovada exige humano identificado; ator interno não
        // substitui a revisão humana de um histórico sem preparador.
        if (approver.type !== 'user') {
          throw new DotApprovalSeparationError(
            'Ação legada sem preparação registrada só pode ser aprovada por usuário autenticado.',
          );
        }
        separationDecision = 'no_preparer_recorded';
      } else if (preparerType === 'dot') {
        // Contrato de auditoria: ator `dot` é interno e NÃO tem usuário.
        // actor_id preenchido (inclusive string vazia) é histórico inválido e
        // não pode ser convertido em aprovação.
        if (preparer.actor_id !== null && preparer.actor_id !== undefined) {
          throw new DotApprovalSeparationError();
        }
        separationDecision = 'internal_actor';
      } else if (preparerType === 'user') {
        // Evento humano sem identidade válida é inválido: não há como provar
        // separação de funções, então a aprovação falha fechada.
        if (!preparerId) throw new DotApprovalSeparationError();
        // Ação preparada por humano exige aprovação humana: ator interno do
        // Dot não substitui a barreira de revisão humana.
        if (approver.type === 'dot') {
          throw new DotApprovalSeparationError(
            'Ação preparada por usuário exige aprovação de outro usuário autenticado.',
          );
        }

        if (approver.userId === preparerId) {
          let ownerExists = false;
          try {
            // Existência direta do vínculo (empresa, usuário); não infere
            // owner a partir de uma linha arbitrária da tabela.
            const owner = await tx.get(
              'SELECT 1 AS ok FROM empresa_owners WHERE empresa_id = ? AND user_id = ?',
              [empresaId, approver.userId],
            );
            ownerExists = Boolean(owner);
          } catch {
            // Sem tabela de owners: sem exceção possível (fail-closed).
            ownerExists = false;
          }
          if (!ownerExists) {
            throw new DotApprovalSeparationError();
          }
          separationDecision = 'owner_override';
          ownerOverride = true;
        } else {
          separationDecision = 'distinct_actors';
        }
      } else {
        // Tipo desconhecido no histórico auditável: bloqueia a aprovação.
        throw new DotApprovalSeparationError();
      }

      const separationMetadata = {
        separation_decision: separationDecision,
        owner_override: ownerOverride,
        preparer_id: preparerId,
        preparer_actor_type: preparerType,
        approver_actor_type: approverAudit.actorType,
        approver_id: approverAudit.actorId,
        ...(approver.type === 'dot' ? { approver_source: approver.source } : {}),
        ...(legacyMarker
          ? {
              legacy_migration_marker: legacyMarker.marker,
              legacy_migration_reason: legacyMarker.reason,
            }
          : {}),
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
        [
          empresaId,
          actionId,
          Number(action.decision_id),
          'approved',
          approverAudit.actorType,
          approverAudit.actorId,
          JSON.stringify(separationMetadata).slice(0, 12000),
          now,
        ],
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

export async function executeDotAction(
  empresaId: string,
  actionId: number,
  actor: DotActor | null | undefined,
) {
  await ensureDotActionSchema();
  return executeDotActionThroughGateway(empresaId, actionId, actor);
}
