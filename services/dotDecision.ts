import type { Database } from 'sqlite';
import { getDb } from '../lib/db.js';

export type DotOption = {
  id: 'opcao_1' | 'opcao_2';
  title: string;
  description: string;
  action: string;
  risk: 'baixo' | 'medio' | 'alto';
};

export type DotDecision = {
  id?: number;
  eventId: number;
  type: 'monitoramento' | 'crise_reputacional' | 'oportunidade';
  priority: 'baixa' | 'media' | 'alta' | 'critica';
  severity: string;
  reason: string;
  evidence: string[];
  recommendation: string;
  options: DotOption[];
  requiresApproval: boolean;
  status: 'pending' | 'prepared' | 'approved' | 'rejected';
  createdAt?: string;
};

async function ensureSchema() {
  const db = getDb();
  await db.exec(`CREATE TABLE IF NOT EXISTS dot_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id TEXT NOT NULL,
    event_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    priority TEXT NOT NULL,
    severity TEXT NOT NULL,
    reason TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    recommendation TEXT NOT NULL,
    options_json TEXT NOT NULL DEFAULT '[]',
    requires_approval INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  )`);
  const columns = await db.all('PRAGMA table_info(dot_decisions)');
  if (!(columns || []).some((c: any) => c.name === 'options_json')) {
    await db.exec("ALTER TABLE dot_decisions ADD COLUMN options_json TEXT NOT NULL DEFAULT '[]'");
  }
}

function classify(event: any): DotDecision {
  const critical = event.severity === 'critical' || event.type === 'rating_drop';
  return {
    eventId: Number(event.id),
    type: critical ? 'crise_reputacional' : 'monitoramento',
    priority: event.severity === 'critical' ? 'critica' : event.severity === 'warning' ? 'alta' : 'media',
    severity: event.severity,
    reason: event.details,
    evidence: [event.title, event.details],
    recommendation: critical
      ? 'O sinal merece tratamento prioritário. O Dot deve verificar os fatos e apresentar duas formas objetivas de resolver a pendência.'
      : 'O sinal deve ser acompanhado e, se confirmado, o Dot deve apresentar duas formas objetivas de resolver a pendência.',
    options: critical
      ? [
          { id: 'opcao_1', title: 'Resolver diretamente', description: 'Priorizar a pendência e preparar uma resposta ao cliente.', action: 'priorizar_e_resolver', risk: 'medio' },
          { id: 'opcao_2', title: 'Escalar para responsável', description: 'Encaminhar com contexto, evidências e prazo de acompanhamento.', action: 'escalar_responsavel', risk: 'baixo' },
        ]
      : [
          { id: 'opcao_1', title: 'Acompanhar e corrigir', description: 'Atuar sobre a causa identificada e acompanhar o resultado.', action: 'corrigir_e_acompanhar', risk: 'medio' },
          { id: 'opcao_2', title: 'Escalar para responsável', description: 'Enviar o caso ao responsável com contexto e evidências.', action: 'escalar_responsavel', risk: 'baixo' },
        ],
    requiresApproval: true,
    status: 'pending',
  };
}

/**
 * Cria decisões para eventos recém-criados.
 *
 * O parâmetro `dbOverride` permite rodar dentro da mesma transação que criou
 * os eventos (ver `dotMonitor`), tornando o check-then-insert atômico. O id da
 * decisão é relido pelo par `(empresa_id, event_id)` — `run` não devolve o id
 * em Postgres (o adapter descarta `RETURNING`).
 */
export async function createDecisionsForEvents(empresaId: string, events: any[], dbOverride?: Database) {
  await ensureSchema();
  const db = dbOverride || getDb();
  const created = [];
  for (const event of events || []) {
    const exists = await db.get('SELECT id FROM dot_decisions WHERE empresa_id = ? AND event_id = ? LIMIT 1', [empresaId, event.id]);
    if (exists) continue;
    const d = classify(event);
    await db.run(
      'INSERT INTO dot_decisions (empresa_id,event_id,type,priority,severity,reason,evidence_json,recommendation,options_json,requires_approval,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [empresaId,d.eventId,d.type,d.priority,d.severity,d.reason,JSON.stringify(d.evidence),d.recommendation,JSON.stringify(d.options),d.requiresApproval ? 1 : 0,d.status,new Date().toISOString()]
    );
    const inserted = await db.get(
      'SELECT id FROM dot_decisions WHERE empresa_id = ? AND event_id = ? ORDER BY id DESC LIMIT 1',
      [empresaId, d.eventId]
    );
    created.push({ ...d, id: Number(inserted?.id) || 0 });
  }
  return created;
}

export async function updateDotDecision(empresaId: string, id: number, status: 'prepared' | 'approved' | 'rejected') {
  await ensureSchema();
  const db = getDb();
  const row = await db.get('SELECT id, status FROM dot_decisions WHERE id = ? AND empresa_id = ? LIMIT 1', [id, empresaId]);
  if (!row) return null;

  const current = String(row.status);
  const allowed: Record<string, string[]> = {
    pending: ['prepared', 'rejected'],
    prepared: ['approved', 'rejected'],
  };
  if (!allowed[current]?.includes(status)) return null;

  const updated = await db.run(
    'UPDATE dot_decisions SET status = ? WHERE id = ? AND empresa_id = ? AND status = ?',
    [status, id, empresaId, current]
  );
  if (!updated || updated.changes !== 1) return null;
  return { id, status };
}

export async function listDotDecisions(empresaId: string) {
  await ensureSchema();
  const rows = await getDb().all('SELECT * FROM dot_decisions WHERE empresa_id = ? ORDER BY id DESC LIMIT 50',[empresaId]);
  return (rows || []).map((r:any) => ({...r, evidence: JSON.parse(r.evidence_json || '[]'), options: JSON.parse(r.options_json || '[]'), requiresApproval: Boolean(r.requires_approval), createdAt: r.created_at}));
}
