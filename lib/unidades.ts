/**
 * Multi-unidades / filiais (Corporativo, Rei e trial).
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

  // Migra tabelas antigas incompletas
  const cols = (await db.all(`PRAGMA table_info(unidades)`)).map((c: any) => String(c.name));
  const add = async (name: string, ddl: string) => {
    if (!cols.includes(name)) {
      await db.exec(`ALTER TABLE unidades ADD COLUMN ${ddl}`);
    }
  };
  await add('endereco', 'endereco TEXT');
  await add('cidade', 'cidade TEXT');
  await add('google_place_id', 'google_place_id TEXT');
  await add('google_review_url', 'google_review_url TEXT');
  await add('ativo', 'ativo INTEGER NOT NULL DEFAULT 1');
  await add('created_at', "created_at TEXT NOT NULL DEFAULT (datetime('now'))");

  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_unidades_empresa ON unidades(empresa_id)`
  );
}

export function planPermiteUnidades(plan: string | null | undefined): boolean {
  const p = String(plan || '').toLowerCase().trim();
  return p === 'corporativo' || p === 'rei' || p === 'trial' || p === 'teste';
}

export async function listUnidades(empresaId: string, db: Database = getDb()) {
  await ensureUnidadesSchema(db);
  return db.all(
    `SELECT id, empresa_id, nome, endereco, cidade, google_place_id, google_review_url,
            IFNULL(ativo, 1) as ativo, created_at
     FROM unidades
     WHERE empresa_id = ? AND IFNULL(ativo, 1) = 1
     ORDER BY nome ASC`,
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
  const nome = String(opts.nome || '').trim().slice(0, 120);
  if (!nome) throw Object.assign(new Error('Nome da unidade obrigatório.'), { status: 400 });

  await db.run(
    `INSERT INTO unidades (id, empresa_id, nome, endereco, cidade, google_place_id, google_review_url, ativo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`,
    [
      id,
      opts.empresaId,
      nome,
      opts.endereco ? String(opts.endereco).slice(0, 200) : null,
      opts.cidade ? String(opts.cidade).slice(0, 80) : null,
      opts.google_place_id ? String(opts.google_place_id).slice(0, 120) : null,
      opts.google_review_url ? String(opts.google_review_url).slice(0, 500) : null,
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
