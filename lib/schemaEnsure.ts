/**
 * Garante colunas extras em Postgres/SQLite (schemas legados no Render).
 */
import type { Database } from 'sqlite';

async function columnNames(db: Database, table: string): Promise<Set<string>> {
  try {
    const rows = await db.all(`PRAGMA table_info(${table})`);
    return new Set((rows || []).map((r: any) => String(r.name)));
  } catch {
    return new Set();
  }
}

async function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  ddlType: string
) {
  const cols = await columnNames(db, table);
  if (cols.has(column)) return;
  try {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
    console.log(`[schema] + ${table}.${column}`);
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (!/already exists|duplicate column/i.test(msg)) {
      console.warn(`[schema] ${table}.${column}:`, msg);
    }
  }
}

/** Colunas usadas pelo trial, painel e billing. */
export async function ensureRuntimeSchema(db: Database) {
  await addColumnIfMissing(db, 'empresas', 'slug', 'TEXT');
  await addColumnIfMissing(db, 'empresas', 'google_review_url', 'TEXT');
  await addColumnIfMissing(db, 'empresas', 'whatsapp_suporte', 'TEXT');
  await addColumnIfMissing(db, 'empresas', 'voice_style', 'TEXT');
  await addColumnIfMissing(db, 'empresas', 'empresa_pai_id', 'TEXT');
  await addColumnIfMissing(db, 'empresas', 'payment_gateway', 'TEXT');
  await addColumnIfMissing(db, 'empresas', 'mp_preapproval_id', 'TEXT');
  await addColumnIfMissing(db, 'empresas', 'billing_cycle', 'TEXT');
  await addColumnIfMissing(db, 'empresas', 'cancel_at_period_end', 'INTEGER DEFAULT 0');
  await addColumnIfMissing(db, 'empresas', 'stripe_customer_id', 'TEXT');
  await addColumnIfMissing(db, 'empresas', 'stripe_subscription_id', 'TEXT');
  await addColumnIfMissing(db, 'usuarios', 'email', 'TEXT');

  try {
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_cnpj ON empresas(cnpj)`);
  } catch {
    /* */
  }
  try {
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_slug ON empresas(slug)`);
  } catch {
    /* */
  }
  try {
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email)`);
  } catch {
    /* */
  }
}
