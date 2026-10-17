import { getDb } from '../lib/db.js';

export type DotAutonomy = 'observador' | 'assistente' | 'proativo' | 'autonomo_controlado';

export type DotPreferences = {
  autonomy: DotAutonomy;
  checkIntervalMinutes: number;
  dailySummary: boolean;
  immediateAlerts: boolean;
  alertOnRatingDrop: boolean;
  ratingFloor: number;
  alertOnCriticalTheme: boolean;
  prepareActionsAutomatically: boolean;
  requireApprovalForExternalActions: boolean;
};

export const DEFAULT_DOT_PREFERENCES: DotPreferences = {
  autonomy: 'proativo',
  checkIntervalMinutes: 60,
  dailySummary: true,
  immediateAlerts: true,
  alertOnRatingDrop: true,
  ratingFloor: 4.5,
  alertOnCriticalTheme: true,
  prepareActionsAutomatically: true,
  requireApprovalForExternalActions: true,
};

async function ensureColumns() {
  const db = getDb();
  const cols = (await db.all('PRAGMA table_info(empresas)')).map((c: any) => c.name);
  if (!cols.includes('dot_preferences_json')) {
    await db.exec('ALTER TABLE empresas ADD COLUMN dot_preferences_json TEXT');
  }
}

function normalize(input: any): DotPreferences {
  const p = input || {};
  const autonomy = ['observador', 'assistente', 'proativo', 'autonomo_controlado'].includes(p.autonomy)
    ? p.autonomy
    : DEFAULT_DOT_PREFERENCES.autonomy;
  return {
    autonomy,
    checkIntervalMinutes: Math.min(1440, Math.max(15, Number(p.checkIntervalMinutes) || 60)),
    dailySummary: p.dailySummary !== false,
    immediateAlerts: p.immediateAlerts !== false,
    alertOnRatingDrop: p.alertOnRatingDrop !== false,
    ratingFloor: Math.min(5, Math.max(1, Number(p.ratingFloor) || 4.5)),
    alertOnCriticalTheme: p.alertOnCriticalTheme !== false,
    prepareActionsAutomatically: p.prepareActionsAutomatically !== false,
    requireApprovalForExternalActions: true,
  };
}

export async function getDotPreferences(empresaId: string): Promise<DotPreferences> {
  await ensureColumns();
  const db = getDb();
  const row = await db.get('SELECT dot_preferences_json FROM empresas WHERE id = ?', [empresaId]);
  if (!row?.dot_preferences_json) return { ...DEFAULT_DOT_PREFERENCES };
  try {
    return normalize(JSON.parse(row.dot_preferences_json));
  } catch {
    return { ...DEFAULT_DOT_PREFERENCES };
  }
}

export async function saveDotPreferences(empresaId: string, input: any): Promise<DotPreferences> {
  await ensureColumns();
  const db = getDb();
  const preferences = normalize(input);
  await db.run('UPDATE empresas SET dot_preferences_json = ? WHERE id = ?', [JSON.stringify(preferences), empresaId]);
  return preferences;
}
