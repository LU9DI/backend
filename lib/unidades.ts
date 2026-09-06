/**
 * Multi-unidades / filiais (Corporativo e Rei).
 */
import type { Database } from 'sqlite';
import { getDb } from './db.js';
import crypto from 'crypto';

export async function ensureUnidadesSchema(db: Database = getDb()) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS unidades (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      endereco TEXT,
      cidade TEXT,
      google_place_id TEXT,
      google_review_url TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_unidades_empresa ON unidades(empresa_id)`
  );
}

export function planPermiteUnidades(plan: string | null | undefined): boolean {
  const p = String(plan || '').toLowerCase();
  return p === 'corporativo' || p === 'rei' || p === 'trial' || p === 'teste';
}

export async function listUnidades(empresaId: string, db: Database = getDb()) {
  await ensureUnidadesSchema(db);
  return db.all(
    `SELECT * FROM unidades WHERE empresa_id = ? AND IFNULL(ativo,1) = 1 ORDER BY nome ASC`,
    [empresaId]
  );
}

export async function createUnidade(
  opts: {
    empresaId: string;
    nome: string;
    endereco?: string | null;
    cidade?: string | null;
    google_place_id?: string | null;
    google_review_url?: string | null;
  },
  db: Database = getDb()
) {
  await ensureUnidadesSchema(db);
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO unidades (id, empresa_id, nome, endereco, cidade, google_place_id, google_review_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.empresaId,
      String(opts.nome).slice(0, 120),
      opts.endereco ? String(opts.endereco).slice(0, 200) : null,
      opts.cidade ? String(opts.cidade).slice(0, 80) : null,
      opts.google_place_id || null,
      opts.google_review_url || null,
    ]
  );
  return db.get(`SELECT * FROM unidades WHERE id = ?`, [id]);
}

export async function softDeleteUnidade(
  unidadeId: string,
  empresaId: string,
  db: Database = getDb()
) {
  await ensureUnidadesSchema(db);
  const r = await db.run(
    `UPDATE unidades SET ativo = 0 WHERE id = ? AND empresa_id = ?`,
    [unidadeId, empresaId]
  );
  return Number(r.changes || 0) > 0;
}
