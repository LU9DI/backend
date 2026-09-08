/**
 * Preços dos planos editáveis pelo admin, sem mexer no código.
 */
import type { Database } from 'sqlite';
import { getDb } from './db.js';

export type PlanPriceRow = {
  plan: string;
  month_brl: number;
  year_monthly_brl: number;
  review_limit: number;
};

const DEFAULTS: PlanPriceRow[] = [
  { plan: 'inicial', month_brl: 69.9, year_monthly_brl: 49.9, review_limit: 100 },
  { plan: 'pro', month_brl: 109.9, year_monthly_brl: 99.9, review_limit: 300 },
  { plan: 'ultra', month_brl: 199.9, year_monthly_brl: 149.9, review_limit: 800 },
  { plan: 'corporativo', month_brl: 499.9, year_monthly_brl: 429.9, review_limit: 2500 },
  { plan: 'rei', month_brl: 999.9, year_monthly_brl: 899.9, review_limit: 8000 },
];

export async function ensurePlanPricingSchema(db: Database = getDb()) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS plan_prices (
      plan TEXT PRIMARY KEY,
      month_brl REAL NOT NULL,
      year_monthly_brl REAL NOT NULL,
      review_limit INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  for (const d of DEFAULTS) {
    const row = await db.get(`SELECT plan FROM plan_prices WHERE plan = ?`, [d.plan]);
    if (!row) {
      await db.run(
        `INSERT INTO plan_prices (plan, month_brl, year_monthly_brl, review_limit)
         VALUES (?, ?, ?, ?)`,
        [d.plan, d.month_brl, d.year_monthly_brl, d.review_limit]
      );
    }
  }

  // Oficial do produto (sempre alinhado — corrige legado 150/400 na nuvem)
  await db.run(
    `UPDATE plan_prices SET review_limit = 100, updated_at = datetime('now') WHERE plan = 'inicial'`
  );
  await db.run(
    `UPDATE plan_prices SET review_limit = 300, updated_at = datetime('now') WHERE plan = 'pro'`
  );
  await db.run(
    `UPDATE plan_prices SET review_limit = 800, updated_at = datetime('now') WHERE plan = 'ultra'`
  );
  await db.run(
    `UPDATE plan_prices SET review_limit = 2500, updated_at = datetime('now') WHERE plan = 'corporativo'`
  );
  await db.run(
    `UPDATE plan_prices SET review_limit = 8000, updated_at = datetime('now') WHERE plan = 'rei'`
  );
}

export async function getAnnualDiscountPct(db: Database = getDb()): Promise<number> {
  await ensurePlanPricingSchema(db);
  const row = await db.get(`SELECT value FROM system_settings WHERE key = 'annual_discount_pct'`);
  if (!row) return 0;
  const n = Number(row.value);
  return Number.isFinite(n) ? Math.min(50, Math.max(0, n)) : 0;
}

export async function setAnnualDiscountPct(pct: number, db: Database = getDb()) {
  await ensurePlanPricingSchema(db);
  const v = Math.min(50, Math.max(0, Number(pct) || 0));
  await db.run(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ('annual_discount_pct', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [String(v)]
  );
  return v;
}

export async function listPlanPrices(db: Database = getDb()): Promise<{
  planos: PlanPriceRow[];
  annual_discount_pct: number;
}> {
  await ensurePlanPricingSchema(db);
  const rows = await db.all(`SELECT * FROM plan_prices ORDER BY month_brl ASC`);
  const discount = await getAnnualDiscountPct(db);
  const planos = (rows || []).map((r: any) => {
    let year = Number(r.year_monthly_brl);
    if (discount > 0) {
      year = Math.round(Number(r.month_brl) * (1 - discount / 100) * 100) / 100;
    }
    return {
      plan: r.plan,
      month_brl: Number(r.month_brl),
      year_monthly_brl: year,
      year_monthly_base: Number(r.year_monthly_brl),
      review_limit: Number(r.review_limit),
      annual_total_brl: Math.round(year * 12 * 100) / 100,
    };
  });
  return { planos: planos as any, annual_discount_pct: discount };
}

export async function updatePlanPrices(
  updates: Array<{
    plan: string;
    month_brl?: number;
    year_monthly_brl?: number;
    review_limit?: number;
  }>,
  annualDiscountPct?: number | null,
  db: Database = getDb()
) {
  await ensurePlanPricingSchema(db);
  const allowed = new Set(DEFAULTS.map((d) => d.plan));

  for (const u of updates || []) {
    const plan = String(u.plan || '').toLowerCase();
    if (!allowed.has(plan)) continue;
    const cur = await db.get(`SELECT * FROM plan_prices WHERE plan = ?`, [plan]);
    if (!cur) continue;
    const month =
      u.month_brl != null && Number(u.month_brl) > 0
        ? Math.round(Number(u.month_brl) * 100) / 100
        : Number(cur.month_brl);
    const yearM =
      u.year_monthly_brl != null && Number(u.year_monthly_brl) > 0
        ? Math.round(Number(u.year_monthly_brl) * 100) / 100
        : Number(cur.year_monthly_brl);
    const limit =
      u.review_limit != null && Number(u.review_limit) > 0
        ? Math.floor(Number(u.review_limit))
        : Number(cur.review_limit);
    await db.run(
      `UPDATE plan_prices SET month_brl = ?, year_monthly_brl = ?, review_limit = ?,
       updated_at = datetime('now') WHERE plan = ?`,
      [month, yearM, limit, plan]
    );
  }

  if (annualDiscountPct != null) {
    await setAnnualDiscountPct(annualDiscountPct, db);
  }

  return listPlanPrices(db);
}

export async function applyDbPricesToPlanos(
  planos: Record<string, any>,
  db: Database = getDb()
) {
  const { planos: rows, annual_discount_pct } = await listPlanPrices(db);
  for (const r of rows as any[]) {
    const monthKey = r.plan;
    const yearKey = `${r.plan}-anual`;
    let yearMonthly = Number(r.year_monthly_base ?? r.year_monthly_brl);
    if (annual_discount_pct > 0) {
      yearMonthly =
        Math.round(Number(r.month_brl) * (1 - annual_discount_pct / 100) * 100) / 100;
    }
    if (planos[monthKey]) {
      planos[monthKey].displayMonthly = Number(r.month_brl);
      planos[monthKey].unitAmount = Math.round(Number(r.month_brl) * 100);
      if (r.review_limit) planos[monthKey].reviewLimit = r.review_limit;
    }
    if (planos[yearKey]) {
      planos[yearKey].displayMonthly = yearMonthly;
      planos[yearKey].unitAmount = Math.round(yearMonthly * 12 * 100);
      if (r.review_limit) planos[yearKey].reviewLimit = r.review_limit;
    }
  }
}
