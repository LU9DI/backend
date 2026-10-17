import { randomUUID } from 'node:crypto';
import { getDb } from '../lib/db.js';

/**
 * Coordenação durável entre instâncias (tabela `dot_locks`).
 *
 * O DOT protege a concorrência dentro de um processo com travas em memória e
 * filas de transação; isso não basta quando duas instâncias da API rodam
 * contra o mesmo banco. Esta tabela dá um claim atômico no banco, compatível
 * com SQLite e Postgres:
 *
 *  - `name` é a chave única do recurso (ex.: `monitor:<empresa>`,
 *    `mission:<empresa>:<missão>`, `dot:scheduler`);
 *  - adquirir = INSERT ... ON CONFLICT(name) DO UPDATE ... WHERE expirado.
 *    O upsert devolve `changes = 1` para exatamente uma instância; as demais
 *    recebem `changes = 0` (lock ocupado e não expirado);
 *  - `expires_at` (TTL) dá a recuperação segura após falhas: uma instância que
 *    cair no meio do trabalho deixa de renovar o lock e outra instância pode
 *    assumi-lo quando o prazo expira — sem depender de limpeza manual;
 *  - liberar = DELETE escopado pelo dono (`locked_by`), então uma instância
 *    nunca remove o lock de outra.
 *
 * Nada aqui guarda segredo ou conteúdo de avaliação: só nome do recurso,
 * identificador do dono (pid + uuid) e prazos.
 */

async function ensureLockTable() {
  await getDb().exec(`CREATE TABLE IF NOT EXISTS dot_locks (
    name TEXT PRIMARY KEY,
    locked_by TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`);
}

export async function acquireDotLock(name: string, ttlMs: number): Promise<string | null> {
  await ensureLockTable();
  const owner = `${process.pid}-${randomUUID()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Math.max(1000, Math.trunc(ttlMs))).toISOString();
  const result = (await getDb().run(
    `INSERT INTO dot_locks (name, locked_by, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET locked_by = ?, expires_at = ?
     WHERE dot_locks.expires_at <= ?`,
    [name, owner, expiresAt, owner, expiresAt, now.toISOString()],
  )) as { changes?: number };
  return Number(result?.changes || 0) === 1 ? owner : null;
}

export async function releaseDotLock(name: string, owner: string): Promise<void> {
  try {
    await getDb().run('DELETE FROM dot_locks WHERE name = ? AND locked_by = ?', [name, owner]);
  } catch {
    /* liberação é best-effort; o TTL cobre falhas de liberação */
  }
}

/**
 * Executa `work` sob o lock durável `name`.
 *
 * `waitMs` > 0 faz a segunda instância aguardar o lock (com polling); com
 * `waitMs` 0 ela desiste imediatamente e o chamador decide o que fazer.
 * O resultado nunca mistura execuções: quando `acquired` é `true`, `work`
 * rodou exatamente uma vez, nesta instância.
 */
export async function withDotLock<T>(
  name: string,
  ttlMs: number,
  work: () => Promise<T>,
  options: { waitMs?: number; pollMs?: number } = {},
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  const waitMs = Math.max(0, Number(options.waitMs) || 0);
  const pollMs = Math.max(50, Number(options.pollMs) || 250);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const owner = await acquireDotLock(name, ttlMs);
    if (owner) {
      try {
        const result = await work();
        return { acquired: true, result };
      } finally {
        await releaseDotLock(name, owner);
      }
    }
    if (Date.now() >= deadline) return { acquired: false };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
