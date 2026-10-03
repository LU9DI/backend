import { getDb } from '../lib/db.js';
import { getDotPreferences } from './dotPreferences.js';
import { createDecisionsForEvents } from './dotDecision.js';
import { prepareDotActionFromDecision } from './dotActionQueue.js';
import { evaluateDotPolicy } from './dotPolicy.js';

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
  await ensureSchema();
  const db = getDb();
  const preferences = await getDotPreferences(empresaId);
  if (preferences.autonomy === 'observador' && !preferences.immediateAlerts) {
    return { ok: true, skipped: true, reason: 'monitoramento desativado pelas preferências', events: [] };
  }

  const rows = await db.all(
    'SELECT rating, ai_tags, createdAt FROM reviews WHERE empresa_id = ? AND IFNULL(is_test, 0) != 1 ORDER BY id DESC LIMIT 200',
    [empresaId]
  );
  const reviews = rows || [];
  const average = reviews.length
    ? reviews.reduce((s: number, r: any) => s + Number(r.rating || 0), 0) / reviews.length
    : 0;

  const events: any[] = [];
  if (preferences.alertOnRatingDrop && reviews.length >= 5 && average < preferences.ratingFloor) {
    events.push({
      type: 'rating_drop',
      severity: average < preferences.ratingFloor - 0.3 ? 'critical' : 'warning',
      title: 'Queda de nota detectada',
      details: `A média das últimas ${reviews.length} avaliações analisadas está em ${average.toFixed(1)}/5, abaixo do limite configurado de ${preferences.ratingFloor.toFixed(1)}.`,
    });
  }

  const counts: Record<string, number> = {};
  for (const r of reviews) {
    try {
      const tags = JSON.parse(String(r.ai_tags || '[]'));
      if (Array.isArray(tags)) for (const tag of tags) {
        const key = String(tag).trim();
        if (key) counts[key] = (counts[key] || 0) + 1;
      }
    } catch {}
  }
  if (preferences.alertOnCriticalTheme) {
    const top = Object.entries(counts).sort((a,b) => b[1]-a[1])[0];
    if (top && top[1] >= 5) {
      events.push({
        type: 'recurring_theme',
        severity: 'warning',
        title: 'Tema recorrente detectado',
        details: `O tema "${top[0]}" aparece em ${top[1]} avaliações recentes e merece investigação.`,
      });
    }
  }

  const created = [];
  for (const event of events) {
    const duplicate = await db.get(
      'SELECT id FROM dot_events WHERE empresa_id = ? AND type = ? AND acknowledged_at IS NULL AND created_at > ? LIMIT 1',
      [empresaId, event.type, new Date(Date.now() - 24 * 3600000).toISOString()]
    );
    if (duplicate) continue;
    const inserted = await db.run(
      'INSERT INTO dot_events (empresa_id, type, severity, title, details, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      [empresaId, event.type, event.severity, event.title, event.details, new Date().toISOString()]
    );
    created.push({ ...event, id: inserted.lastID });
  }

  const decisions = await createDecisionsForEvents(empresaId, created);
  const policy = evaluateDotPolicy(preferences, created.some((event) => event.severity === 'critical') ? 'critical' : 'medium');
  const preparedActions = [];
  if (policy.prepareAction) {
    for (const decision of decisions) {
      const option = decision.options?.[0];
      if (!option) continue;
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