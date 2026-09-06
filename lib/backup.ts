/**
 * Backup simples do SQLite (cópia com timestamp).
 * Env:
 *   SQLITE_PATH / DB_PATH — caminho do banco
 *   BACKUP_DIR — pasta destino (default: ./backups)
 */
import fs from 'fs';
import path from 'path';
import { getDb } from './db.js';

function resolveDbPath(): string {
  return (
    process.env.SQLITE_PATH ||
    process.env.DB_PATH ||
    path.join(process.cwd(), 'data', 'filtra.sqlite')
  );
}

export function backupDir(): string {
  return process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
}

export async function createSqliteBackup(): Promise<{
  ok: boolean;
  path?: string;
  bytes?: number;
  error?: string;
}> {
  const src = resolveDbPath();
  if (!fs.existsSync(src)) {
    return { ok: false, error: `DB não encontrado: ${src}` };
  }

  try {
    // Checkpoint WAL se possível
    try {
      const db = getDb();
      await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* */
    }

    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dir, `filtra-${stamp}.sqlite`);
    fs.copyFileSync(src, dest);
    const stat = fs.statSync(dest);

    // Mantém no máximo 14 backups
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('filtra-') && f.endsWith('.sqlite'))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const old of files.slice(14)) {
      try {
        fs.unlinkSync(path.join(dir, old.f));
      } catch {
        /* */
      }
    }

    return { ok: true, path: dest, bytes: stat.size };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
