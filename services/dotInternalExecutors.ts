import { getDb } from '../lib/db.js';

export type DotInternalExecutionInput = {
  empresaId: string;
  actionId: number;
  decisionId: number;
  action: string;
  eventId?: number | null;
  priority?: string | null;
  reason?: string | null;
};

export type DotInternalExecutionResult = {
  caseId: number;
  status: string;
  nextStep: string;
  created: boolean;
};

const outcomes: Record<string, { status: string; nextStep: string }> = {
  priorizar_e_resolver: {
    status: 'prioritized',
    nextStep: 'Validar a evidência, executar a tratativa interna e registrar a resolução antes de qualquer contato externo.',
  },
  escalar_responsavel: {
    status: 'escalated',
    nextStep: 'Responsável deve revisar o caso, definir a tratativa e registrar o resultado.',
  },
  corrigir_e_acompanhar: {
    status: 'monitoring',
    nextStep: 'Aplicar a correção interna e acompanhar o resultado pelo follow-up do DOT.',
  },
};

async function ensureSchema() {
  const db = getDb();
  await db.exec(`CREATE TABLE IF NOT EXISTS dot_internal_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id TEXT NOT NULL,
    decision_id INTEGER NOT NULL,
    action_id INTEGER NOT NULL,
    event_id INTEGER,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT NOT NULL,
    summary TEXT NOT NULL,
    next_step TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_dot_internal_cases_action ON dot_internal_cases(empresa_id, action_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_dot_internal_cases_empresa_status ON dot_internal_cases(empresa_id, status, updated_at)');
}

export async function executeDotInternalAction(input: DotInternalExecutionInput): Promise<DotInternalExecutionResult> {
  await ensureSchema();
  const db = getDb();
  const now = new Date().toISOString();
  const outcome = outcomes[input.action] || {
    status: 'open',
    nextStep: 'Revisar o caso no painel do DOT e definir a próxima etapa.',
  };

  const existing = await db.get(
    'SELECT id,status,next_step AS nextStep FROM dot_internal_cases WHERE empresa_id=? AND action_id=? LIMIT 1',
    [input.empresaId, input.actionId],
  );

  if (existing) {
    await db.run(
      'UPDATE dot_internal_cases SET status=?,priority=?,summary=?,next_step=?,updated_at=? WHERE id=? AND empresa_id=?',
      [
        outcome.status,
        String(input.priority || 'media'),
        String(input.reason || 'Caso operacional do DOT.').slice(0, 4000),
        outcome.nextStep,
        now,
        existing.id,
        input.empresaId,
      ],
    );
    return {
      caseId: Number(existing.id),
      status: outcome.status,
      nextStep: outcome.nextStep,
      created: false,
    };
  }

  const result = await db.run(
    'INSERT INTO dot_internal_cases (empresa_id,decision_id,action_id,event_id,action,status,priority,summary,next_step,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id',
    [
      input.empresaId,
      input.decisionId,
      input.actionId,
      input.eventId ?? null,
      input.action,
      outcome.status,
      String(input.priority || 'media'),
      String(input.reason || 'Caso operacional do DOT.').slice(0, 4000),
      outcome.nextStep,
      now,
      now,
    ],
  ) as unknown as { changes: number; lastID?: number | bigint; lastInsertRowid?: number | bigint; id?: number | bigint };

  return {
    caseId: Number(result.lastID ?? result.lastInsertRowid ?? result.id),
    status: outcome.status,
    nextStep: outcome.nextStep,
    created: true,
  };
}
