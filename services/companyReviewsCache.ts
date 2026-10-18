/**
 * Fonte compartilhada e cache de avaliações usado pelo painel e pelo relatório mensal.
 * O cache guarda o conjunto completo da empresa; limites de exibição são aplicados
 * somente na camada do painel, nunca na fonte usada para cálculos mensais.
 */
type ReviewCacheEntry = { expiresAt: number; rows: any[] };
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_COMPANIES = 250;
const reviewCache = new Map<string, ReviewCacheEntry>();
const inFlight = new Map<string, { version: number; promise: Promise<any[]> }>();
const cacheVersions = new Map<string, number>();
const databaseIds = new WeakMap<object, number>();
let nextDatabaseId = 1;
function cacheKey(db: object, empresaId: string): string {
  let databaseId = databaseIds.get(db);
  if (!databaseId) { databaseId = nextDatabaseId++; databaseIds.set(db, databaseId); }
  return `${databaseId}:${String(empresaId)}`;
}

export async function loadCompanyReviewsCached(db: any, empresaId: string): Promise<any[]> {
  const key = cacheKey(db, empresaId);
  const now = Date.now();
  const cached = reviewCache.get(key);
  if (cached && cached.expiresAt > now) {
    // Refresh insertion order for simple LRU eviction.
    reviewCache.delete(key);
    reviewCache.set(key, cached);
    return cached.rows;
  }
  if (cached) reviewCache.delete(key);
  const version = cacheVersions.get(key) ?? 0;
  const pending = inFlight.get(key);
  if (pending && pending.version === version) return pending.promise;

  const load = (async () => {
    const queries = [
      'SELECT * FROM reviews WHERE empresa_id = ? ORDER BY createdAt DESC',
      'SELECT * FROM reviews WHERE empresa_id = ? ORDER BY "createdAt" DESC',
      'SELECT * FROM reviews WHERE empresa_id = ? ORDER BY created_at DESC',
      'SELECT * FROM reviews WHERE empresa_id = ? ORDER BY id DESC',
      'SELECT * FROM reviews WHERE empresa_id = ?',
    ];
    let lastError: unknown;
    for (const query of queries) {
      try {
        const rows = await db.all(query, [empresaId]);
        const safeRows = Array.isArray(rows) ? rows : [];
        // Uma escrita pode invalidar o cache enquanto a consulta está em andamento.
        // Nesse caso, a resposta antiga pode ser devolvida a quem já aguardava,
        // mas não pode repovoar o cache nem sobrescrever a leitura mais nova.
        if ((cacheVersions.get(key) ?? 0) === version) {
          reviewCache.set(key, { rows: safeRows, expiresAt: Date.now() + CACHE_TTL_MS });
        }
        while (reviewCache.size > CACHE_MAX_COMPANIES) {
          const oldest = reviewCache.keys().next().value;
          if (oldest === undefined) break;
          reviewCache.delete(oldest);
        }
        return safeRows;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Falha ao carregar avaliações da empresa.');
  })();
  const entry = { version, promise: load };
  inFlight.set(key, entry);
  try {
    return await load;
  } finally {
    if (inFlight.get(key) === entry) inFlight.delete(key);
  }
}

/** Invalida todas as conexões em cache para a empresa, inclusive consultas em andamento. */
export function invalidateCompanyReviewsCache(empresaId: string): void {
  const suffix = `:${String(empresaId)}`;
  const keys = new Set([...reviewCache.keys(), ...inFlight.keys(), ...cacheVersions.keys()]);
  for (const key of keys) {
    if (!key.endsWith(suffix)) continue;
    cacheVersions.set(key, (cacheVersions.get(key) ?? 0) + 1);
    reviewCache.delete(key);
    inFlight.delete(key);
  }
}
