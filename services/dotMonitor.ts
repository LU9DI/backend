import { getDb, withDbTransaction } from '../lib/db.js';
import { getDotPreferences } from './dotPreferences.js';
import { createDecisionsForEvents } from './dotDecision.js';
import { prepareDotActionFromDecision } from './dotActionQueue.js';
import { evaluateDotPolicy } from './dotPolicy.js';
import { withDotLock } from './dotCoordination.js';

/**
 * Monitor do Dot: lê os sinais reais das avaliações da empresa e cria eventos,
 * decisões e (quando a política permite) ações preparadas.
 *
 * Nada é executado aqui. Preparar uma ação é diferente de aprová-la ou
 * executá-la — essas etapas continuam no gateway de execução.
 */

type ReviewRow = {
  rating?: number | string | null;
  ai_tags?: string | null;
  createdAt?: string | null;
};

type DotMonitorEvent = {
  type: string;
  severity: 'critical' | 'warning';
  title: string;
  details: string;
};

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function ensureSchema() {
  const db = getDb();
  await db.exec(`CREATE TABLE IF NOT EXISTS dot_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id TEXT NOT NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    details TEXT NOT NULL,
    created_at TEXT NOT NULL,
    acknowledged_at TEXT
  )`);
}

export async function runDotMonitor(empresaId: string) {
  // Coordenação durável entre instâncias: a rodada do monitor de uma empresa
  // roda em no máximo uma instância por vez. Sem isso, duas instâncias em
  // READ COMMITTED passavam juntas pelo check-then-insert e duplicavam
  // eventos/decisões. Quem não obtém o lock devolve `skipped` (o próximo
  // ciclo reexecuta); o TTL do lock cobre a queda de uma instância no meio
  // da rodada.
  const lock = await withDotLock(`monitor:${empresaId}`, 5 * 60_000, () => runDotMonitorUnlocked(empresaId), {
    waitMs: 0,
  });
  if (!lock.acquired) {
    return {
      ok: true,
      skipped: true,
      reason: 'outra instância já está executando o monitor desta empresa',
      events: [],
    };
  }
  return lock.result;
}

async function runDotMonitorUnlocked(empresaId: string) {
  await ensureSchema();
  const db = getDb();
  const preferences = await getDotPreferences(empresaId);
  if (preferences.autonomy === 'observador' && !preferences.immediateAlerts) {
    return { ok: true, skipped: true, reason: 'monitoramento desativado pelas preferências', events: [] };
  }

  const rows: ReviewRow[] = await db.all(
    'SELECT rating, ai_tags, createdAt FROM reviews WHERE empresa_id = ? AND IFNULL(is_test, 0) != 1 ORDER BY id DESC LIMIT 200',
    [empresaId]
  );
  const reviews = rows || [];
  const average = reviews.length
    ? reviews.reduce((sum, review) => sum + num(review.rating), 0) / reviews.length
    : 0;

  const events: DotMonitorEvent[] = [];
  if (preferences.alertOnRatingDrop && reviews.length >= 5 && average < preferences.ratingFloor) {
    events.push({
      type: 'rating_drop',
      severity: average < preferences.ratingFloor - 0.3 ? 'critical' : 'warning',
      title: 'Queda de nota detectada',
      details: `A média das últimas ${reviews.length} avaliações analisadas está em ${average.toFixed(1)}/5, abaixo do limite configurado de ${preferences.ratingFloor.toFixed(1)}.`,
    });
  }

  const counts: Record<string, number> = {};
  for (const review of reviews) {
    try {
      const tags: unknown = JSON.parse(String(review.ai_tags || '[]'));
      if (Array.isArray(tags)) {
        for (const tag of tags) {
          const key = String(tag).trim();
          if (key) counts[key] = (counts[key] || 0) + 1;
        }
      }
    } catch {
      // Tags inválidas não impedem o monitoramento.
    }
  }
  if (preferences.alertOnCriticalTheme) {
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 5) {
      events.push({
        type: 'recurring_theme',
        severity: 'warning',
        title: 'Tema recorrente detectado',
        details: `O tema "${top[0]}" aparece em ${top[1]} avaliações recentes e merece investigação.`,
      });
    }
  }

  // Check-then-insert atômico: a checagem de duplicidade, o insert do evento e
  // a criação da decisão acontecem na mesma transação serializada. Sem isso,
  // dois monitors concorrentes podiam criar o mesmo evento/decisão em dobro
  // (o bug do "cannot start a transaction within a transaction" também vinha
  // de transações intercaladas). A janela de deduplicação continua a mesma:
  // evento do mesmo tipo, não reconhecido, criado nas últimas 24h.
  const created: Array<DotMonitorEvent & { id: number }> = [];
  const decisions = await withDbTransaction(async (tx) => {
    for (const event of events) {
      const duplicate = await tx.get(
        'SELECT id FROM dot_events WHERE empresa_id = ? AND type = ? AND acknowledged_at IS NULL AND created_at > ? LIMIT 1',
        [empresaId, event.type, new Date(Date.now() - 24 * 3600000).toISOString()]
      );
      if (duplicate) continue;
      const createdAt = new Date().toISOString();
      await tx.run(
        'INSERT INTO dot_events (empresa_id, type, severity, title, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [empresaId, event.type, event.severity, event.title, event.details, createdAt]
      );
      // `run` não devolve o id em Postgres (o adapter descarta RETURNING);
      // reler pela chave recém-inserida dentro da transação é estável.
      const inserted = await tx.get(
        'SELECT id FROM dot_events WHERE empresa_id = ? AND type = ? AND created_at = ? ORDER BY id DESC LIMIT 1',
        [empresaId, event.type, createdAt]
      );
      created.push({ ...event, id: num(inserted?.id) });
    }
    return createDecisionsForEvents(empresaId, created, tx);
  });

  const policy = evaluateDotPolicy(preferences, created.some((event) => event.severity === 'critical') ? 'critical' : 'medium');
  const preparedActions = [];
  if (policy.prepareAction) {
    for (const decision of decisions) {
      const option = decision.options?.[0];
      if (!option) continue;
      if (!decision.id) continue;
      const action = await prepareDotActionFromDecision(empresaId, decision.id, option.id);
      if (action) preparedActions.push(action);
    }
  }
  return {
    ok: true,
    skipped: false,
    average: Number(average.toFixed(2)),
    events: created,
    decisions,
    prepared_actions: preparedActions,
    policy,
    preferences,
  };
}

export async function listDotEvents(empresaId: string) {
  await ensureSchema();
  return getDb().all(
    'SELECT id, type, severity, title, details, created_at, acknowledged_at FROM dot_events WHERE empresa_id = ? ORDER BY id DESC LIMIT 50',
    [empresaId]
  );
}
