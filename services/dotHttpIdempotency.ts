/**
 * Durable HTTP idempotency for the Filtra Dot chat endpoint.
 *
 * Implements the contract in `docs/DOT_HTTP_IDEMPOTENCY.md`:
 *  - singleton key per authenticated tenant (`empresa_id`), never from body;
 *  - SHA-256 of a canonical payload representation;
 *  - atomic claim backed by a unique index (shared by every Render instance);
 *  - `completed` responses are replayed with the original status/JSON;
 *  - `processing` blocks a second execution; a stale lease becomes `ambiguous`
 *    and is never resumed automatically;
 *  - `ambiguous` blocks retries until a human reconciliation;
 *  - `failed_safe` (proven not sent) is the only state that can be retried,
 *    through a conditional, auditable transition;
 *  - the response is persisted before it is sent; a failure to persist is a
 *    hard error and never a success.
 *
 * This service does not replace the token ledger's reservation idempotency.
 */
import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { getDb, withDbTransaction } from '../lib/db.js';
import { incCounter } from '../lib/metrics.js';
import { logEvent } from '../lib/observability.js';

/** Lease after which an unfinished claim is presumed abandoned. */
const PROCESSING_STALE_MS = 15 * 60_000;
/** Retention window for replayable completed responses. */
const COMPLETED_TTL_MS = 24 * 60 * 60_000;
/** Hard cap for a stored response body, mirroring the chat payload budget. */
const MAX_RESPONSE_BYTES = 256_000;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

export type DotHttpIdempotencyStatus =
  | 'processing'
  | 'completed'
  | 'ambiguous'
  | 'failed_safe';

type IdempotencyRow = {
  empresa_id: string;
  endpoint: string;
  idempotency_key: string;
  request_hash: string;
  status: DotHttpIdempotencyStatus;
  response_status: number | null;
  response_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  expires_at: string | null;
};

export type DotHttpIdempotencyClaim = {
  empresaId: string;
  endpoint: string;
  key: string;
  requestHash: string;
};

export type DotHttpIdempotencyClaimResult =
  | { kind: 'claimed'; claim: DotHttpIdempotencyClaim }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'result_expired' }
  | { kind: 'in_progress' }
  | { kind: 'ambiguous' }
  | { kind: 'key_reused' };

/** Mutable per-request state observed by the response wrapper. */
export type DotHttpIdempotencyState = {
  providerAttempted: boolean;
};

export function isValidDotIdempotencyKey(value: unknown): boolean {
  const key = String(value ?? '').trim();
  return key.length > 0
    && key.length <= MAX_IDEMPOTENCY_KEY_LENGTH
    && IDEMPOTENCY_KEY_PATTERN.test(key);
}

/**
 * Tenant that owns an idempotency namespace. Demo never shares a namespace:
 * anonymous demo requests get `null` and are not stored at all, so one visitor
 * can never replay another visitor's response.
 */
export function dotIdempotencyTenant(access: {
  demo: boolean;
  empresaId?: string | null;
  userId?: string | null;
}): string | null {
  if (access.demo) {
    return access.userId ? `demo:${access.userId}` : null;
  }
  return access.empresaId ? String(access.empresaId) : null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      ordered[key] = canonicalize(source[key]);
    }
    return ordered;
  }
  return value;
}

/** Canonical JSON is key-order independent, so retries hash identically. */
export function hashDotHttpPayload(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowSelect(): string {
  return `SELECT empresa_id, endpoint, idempotency_key, request_hash, status,
                 response_status, response_json, created_at, updated_at, completed_at, expires_at
            FROM dot_http_idempotency
           WHERE empresa_id = ? AND idempotency_key = ?`;
}

function replayFrom(row: IdempotencyRow): DotHttpIdempotencyClaimResult {
  if (row.response_json == null || row.response_status == null) {
    throw new Error('Completed Dot HTTP idempotency row has no stored response');
  }
  return {
    kind: 'replay',
    status: Number(row.response_status),
    body: JSON.parse(row.response_json),
  };
}

/**
 * Atomically claims the key or classifies the existing record.
 *
 * The transaction is essential on PostgreSQL: the unique index decides the
 * winner across processes/instances, never an in-memory mutex.
 */
export async function claimDotHttpRequest(input: {
  empresaId: string;
  endpoint: string;
  key: string;
  payload: unknown;
}): Promise<DotHttpIdempotencyClaimResult> {
  const empresaId = String(input.empresaId || '').trim();
  const endpoint = String(input.endpoint || '').trim();
  const key = String(input.key || '').trim();
  if (!empresaId || !endpoint || !key) {
    throw new Error('Invalid Dot HTTP idempotency scope or key');
  }
  if (!isValidDotIdempotencyKey(key)) {
    throw new Error('Invalid Dot HTTP idempotency key format');
  }

  const claim: DotHttpIdempotencyClaim = {
    empresaId,
    endpoint,
    key,
    requestHash: hashDotHttpPayload({ endpoint, payload: input.payload }),
  };
  const now = new Date();
  const nowIsoValue = now.toISOString();
  const staleBefore = new Date(now.getTime() - PROCESSING_STALE_MS).toISOString();
  const expiresAt = new Date(now.getTime() + COMPLETED_TTL_MS).toISOString();

  return withDbTransaction(async (tx) => {
    // Expire response content, never the idempotency tombstone. The tenant,
    // key, request hash and terminal status remain so an old outbox retry can
    // never become a fresh provider execution. failed_safe rows are retained
    // too: deleting them would also reopen the key namespace.
    await tx.run(
      `UPDATE dot_http_idempotency
          SET response_json = NULL
        WHERE status = 'completed' AND expires_at < ? AND response_json IS NOT NULL`,
      [nowIsoValue],
    );

    const inserted = await tx.run(
      `INSERT OR IGNORE INTO dot_http_idempotency
        (empresa_id, endpoint, idempotency_key, request_hash, status,
         created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)`,
      [empresaId, endpoint, key, claim.requestHash, nowIsoValue, nowIsoValue, expiresAt],
    );
    if (inserted.changes === 1) return { kind: 'claimed', claim };

    const existing = await tx.get<IdempotencyRow>(
      rowSelect(),
      [empresaId, key],
    );
    if (!existing) {
      throw new Error('Dot HTTP idempotency row disappeared after unique conflict');
    }
    if (existing.request_hash !== claim.requestHash) return { kind: 'key_reused' };
    if (existing.status === 'completed') {
      if (!existing.expires_at || existing.expires_at < nowIsoValue || existing.response_json == null || existing.response_status == null) {
        return { kind: 'result_expired' };
      }
      return replayFrom(existing);
    }
    if (existing.status === 'ambiguous') return { kind: 'ambiguous' };

    if (existing.status === 'failed_safe') {
      // Retry is allowed only because the row itself records proof that the
      // provider was not reached. The conditional update is the audit trail.
      const retried = await tx.run(
        `UPDATE dot_http_idempotency
            SET status = 'processing', updated_at = ?, expires_at = ?
          WHERE empresa_id = ? AND idempotency_key = ?
            AND status = 'failed_safe'`,
        [nowIsoValue, expiresAt, empresaId, key],
      );
      if (retried.changes === 1) return { kind: 'claimed', claim };
      return { kind: 'in_progress' };
    }

    if (existing.status === 'processing') {
      if (existing.updated_at < staleBefore) {
        // A lease never proves the provider was not called. Promote to
        // ambiguous and require reconciliation; never resume automatically.
        const promoted = await tx.run(
          `UPDATE dot_http_idempotency
              SET status = 'ambiguous', updated_at = ?
            WHERE empresa_id = ? AND idempotency_key = ?
              AND status = 'processing' AND updated_at = ?`,
          [nowIsoValue, empresaId, key, existing.updated_at],
        );
        if (promoted.changes === 1) {
          console.warn(
            '[dot-idempotency] lease expirado promovido para ambíguo:',
            JSON.stringify({ empresaId, endpoint, key_prefix: key.slice(0, 8) }),
          );
          return { kind: 'ambiguous' };
        }

        // A concurrent request may have completed between the read and the
        // stale transition; re-read instead of hiding a committed response.
        const raced = await tx.get<IdempotencyRow>(
          rowSelect(),
          [empresaId, key],
        );
        if (raced?.status === 'completed') {
          if (!raced.expires_at || raced.expires_at < nowIsoValue || raced.response_json == null || raced.response_status == null) {
            return { kind: 'result_expired' };
          }
          return replayFrom(raced);
        }
        if (raced?.status === 'ambiguous') return { kind: 'ambiguous' };
        return { kind: 'in_progress' };
      }
      return { kind: 'in_progress' };
    }

    return { kind: 'in_progress' };
  });
}

/**
 * Atomically stores the replayable response and completes the claim. Returns
 * false when the claim was lost (stale/ambiguous), which must never be sent as
 * success.
 */
export async function completeDotHttpRequest(
  claim: DotHttpIdempotencyClaim,
  status: number,
  body: unknown,
): Promise<boolean> {
  const serialized = JSON.stringify(body);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_RESPONSE_BYTES) {
    await markDotHttpRequestAmbiguous(claim);
    return false;
  }
  const now = nowIso();
  const result = await getDb().run(
    `UPDATE dot_http_idempotency
        SET status = 'completed', response_status = ?, response_json = ?,
            updated_at = ?, completed_at = ?, expires_at = ?
      WHERE empresa_id = ? AND idempotency_key = ?
        AND request_hash = ? AND status = 'processing'`,
    [
      status,
      serialized,
      now,
      now,
      new Date(Date.now() + COMPLETED_TTL_MS).toISOString(),
      claim.empresaId,
      claim.key,
      claim.requestHash,
    ],
  );
  if (result.changes === 1) {
    incCounter('dot_http_idempotency_completed');
    logEvent('info', 'dot_http_idempotency_completed', {
      empresa_id: claim.empresaId,
      endpoint: claim.endpoint,
      response_status: status,
    });
    return true;
  }
  incCounter('dot_http_idempotency_complete_lost');
  logEvent('warn', 'dot_http_idempotency_complete_lost', {
    empresa_id: claim.empresaId,
    endpoint: claim.endpoint,
    response_status: status,
  });
  return false;
}

/** Attach the financial reservation before marking/sending to a provider. */
export async function attachDotHttpReservation(
  claim: DotHttpIdempotencyClaim,
  reservationId: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(reservationId) || reservationId <= 0) return false;
  const result = await getDb().run(
    `UPDATE dot_http_idempotency
        SET reservation_id = ?, updated_at = ?
      WHERE empresa_id = ? AND idempotency_key = ? AND request_hash = ?
        AND status = 'processing' AND reservation_id IS NULL`,
    [reservationId, nowIso(), claim.empresaId, claim.key, claim.requestHash],
  );
  return result.changes === 1;
}

export type DotHttpAmbiguousRecord = {
  id: number;
  empresa_id: string;
  endpoint: string;
  key_prefix: string;
  request_hash_prefix: string;
  created_at: string;
  updated_at: string;
  reservation_id: number | null;
};

/** Metadata-only operator queue; never returns message, full key or response. */
export async function listAmbiguousDotHttpRequests(limit = 100): Promise<DotHttpAmbiguousRecord[]> {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 100)));
  return getDb().all(
    `SELECT id, empresa_id, endpoint,
            SUBSTR(idempotency_key, 1, 8) AS key_prefix,
            SUBSTR(request_hash, 1, 12) AS request_hash_prefix,
            created_at, updated_at, reservation_id
       FROM dot_http_idempotency
      WHERE status = 'ambiguous'
      ORDER BY updated_at ASC, id ASC
      LIMIT ?`,
    [safeLimit],
  ) as Promise<DotHttpAmbiguousRecord[]>;
}

/** Look up an ambiguous record for an operator decision without exposing its key. */
export async function getAmbiguousDotHttpRequest(id: number): Promise<DotHttpAmbiguousRecord | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = await getDb().get(
    `SELECT id, empresa_id, endpoint,
            SUBSTR(idempotency_key, 1, 8) AS key_prefix,
            SUBSTR(request_hash, 1, 12) AS request_hash_prefix,
            created_at, updated_at, reservation_id
       FROM dot_http_idempotency
      WHERE id = ? AND status = 'ambiguous'`,
    [id],
  );
  return (row as DotHttpAmbiguousRecord | undefined) || null;
}

/** The provider may have been reached; the retry must never run again. */
export async function markDotHttpRequestAmbiguous(
  claim: DotHttpIdempotencyClaim,
): Promise<void> {
  const result = await getDb().run(
    `UPDATE dot_http_idempotency
        SET status = 'ambiguous', updated_at = ?
      WHERE empresa_id = ? AND idempotency_key = ?
        AND status = 'processing'`,
    [nowIso(), claim.empresaId, claim.key],
  );
  if (result.changes === 1) {
    incCounter('dot_http_idempotency_ambiguous');
    // Sinal operacional: só existe quando o provedor pode ter sido chamado.
    // Não logar o conteúdo da mensagem.
    logEvent('warn', 'dot_http_idempotency_ambiguous', {
      empresa_id: claim.empresaId,
      endpoint: claim.endpoint,
    });
    console.warn(
      '[dot-idempotency] requisição ambígua (reconciliação necessária):',
      JSON.stringify({ empresaId: claim.empresaId, endpoint: claim.endpoint, key_prefix: claim.key.slice(0, 8) }),
    );
  }
}

/** Proven failure before any provider call; a later retry is safe. */
export async function markDotHttpRequestFailedSafe(
  claim: DotHttpIdempotencyClaim,
): Promise<void> {
  const result = await getDb().run(
    `UPDATE dot_http_idempotency
        SET status = 'failed_safe', updated_at = ?
      WHERE empresa_id = ? AND idempotency_key = ?
        AND status = 'processing'`,
    [nowIso(), claim.empresaId, claim.key],
  );
  if (result.changes === 1) incCounter('dot_http_idempotency_failed_safe');
}

/**
 * Persists the response BEFORE sending it. Classification:
 *  - < 500 and not 429  -> completed (replayable);
 *  - 429 (budget/quota) -> failed_safe (no provider call happened);
 *  - >= 500 with provider attempted -> ambiguous (never auto-retry);
 *  - >= 500 without provider attempt -> failed_safe (safe to retry);
 *  - lost claim or persistence error -> 503, never a success.
 */
export function persistDotHttpResponse(
  res: Response,
  claim: DotHttpIdempotencyClaim,
  state: DotHttpIdempotencyState,
): void {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    const status = res.statusCode || 200;
    const persist = (async (): Promise<'saved' | 'lost'> => {
      if (status >= 500) {
        if (state.providerAttempted) {
          await markDotHttpRequestAmbiguous(claim);
        } else {
          await markDotHttpRequestFailedSafe(claim);
        }
        return 'saved';
      }
      if (status === 429) {
        await markDotHttpRequestFailedSafe(claim);
        return 'saved';
      }
      const saved = await completeDotHttpRequest(claim, status, body);
      if (!saved) {
        await markDotHttpRequestAmbiguous(claim).catch(() => undefined);
        return 'lost';
      }
      return 'saved';
    })();

    return persist
      .then((outcome) => {
        if (outcome === 'lost') {
          res.statusCode = 503;
          return originalJson({
            ok: false,
            error: 'O estado desta solicitação não pôde ser confirmado. A tentativa foi bloqueada para reconciliação.',
            code: 'DOT_IDEMPOTENCY_PERSIST_FAILED',
          });
        }
        return originalJson(body);
      })
      .catch((error) => {
        console.error(
          '[dot-idempotency] falha ao persistir resposta:',
          String(error?.message || error),
        );
        // Falha de persistência após possível chamada externa é ambígua: tenta
        // marcar imediatamente em vez de deixar `processing` até o lease.
        void markDotHttpRequestAmbiguous(claim).catch(() => undefined);
        res.statusCode = 503;
        return originalJson({
          ok: false,
          error: 'O estado desta solicitação não pôde ser confirmado. A tentativa foi bloqueada para reconciliação.',
          code: 'DOT_IDEMPOTENCY_PERSIST_FAILED',
        });
      });
  }) as unknown as Response['json'];
}

