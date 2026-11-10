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

function legacyRowSelect(): string {
  return `SELECT empresa_id, endpoint, idempotency_key, request_hash, status,
                 response_status, response_json, created_at, updated_at, completed_at
            FROM dot_http_idempotency
           WHERE empresa_id = ? AND endpoint = ? AND idempotency_key = ?`;
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
    // Only replayable rows are retention candidates. Processing, ambiguous and
    // failed_safe rows are safety evidence and are never silently discarded.
    await tx.run(
      `DELETE FROM dot_http_idempotency
        WHERE status = 'completed' AND expires_at < ?`,
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
      legacyRowSelect(),
      [empresaId, endpoint, key],
    );
    if (!existing) {
      throw new Error('Dot HTTP idempotency row disappeared after unique conflict');
    }
    if (existing.request_hash !== claim.requestHash) return { kind: 'key_reused' };
    if (existing.status === 'completed') return replayFrom(existing);
    if (existing.status === 'ambiguous') return { kind: 'ambiguous' };

    if (existing.status === 'failed_safe') {
      // Retry is allowed only because the row itself records proof that the
      // provider was not reached. The conditional update is the audit trail.
      const retried = await tx.run(
        `UPDATE dot_http_idempotency
            SET status = 'processing', updated_at = ?, expires_at = ?
          WHERE empresa_id = ? AND endpoint = ? AND idempotency_key = ?
            AND status = 'failed_safe'`,
        [nowIsoValue, expiresAt, empresaId, endpoint, key],
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
            WHERE empresa_id = ? AND endpoint = ? AND idempotency_key = ?
              AND status = 'processing' AND updated_at = ?`,
          [nowIsoValue, empresaId, endpoint, key, existing.updated_at],
        );
        if (promoted.changes === 1) {
          console.warn(
            '[dot-idempotency] lease expirado promovido para ambíguo:',
            JSON.stringify({ empresaId, endpoint, key }),
          );
          return { kind: 'ambiguous' };
        }

        // A concurrent request may have completed between the read and the
        // stale transition; re-read instead of hiding a committed response.
        const raced = await tx.get<IdempotencyRow>(
          legacyRowSelect(),
          [empresaId, endpoint, key],
        );
        if (raced?.status === 'completed') return replayFrom(raced);
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
      WHERE empresa_id = ? AND endpoint = ? AND idempotency_key = ?
        AND request_hash = ? AND status = 'processing'`,
    [
      status,
      serialized,
      now,
      now,
      new Date(Date.now() + COMPLETED_TTL_MS).toISOString(),
      claim.empresaId,
      claim.endpoint,
      claim.key,
      claim.requestHash,
    ],
  );
  return result.changes === 1;
}

/** The provider may have been reached; the retry must never run again. */
export async function markDotHttpRequestAmbiguous(
  claim: DotHttpIdempotencyClaim,
): Promise<void> {
  const result = await getDb().run(
    `UPDATE dot_http_idempotency
        SET status = 'ambiguous', updated_at = ?
      WHERE empresa_id = ? AND endpoint = ? AND idempotency_key = ?
        AND status = 'processing'`,
    [nowIso(), claim.empresaId, claim.endpoint, claim.key],
  );
  if (result.changes === 1) {
    // Sinal operacional: só existe quando o provedor pode ter sido chamado.
    // Não logar o conteúdo da mensagem.
    console.warn(
      '[dot-idempotency] requisição ambígua (reconciliação necessária):',
      JSON.stringify({ empresaId: claim.empresaId, endpoint: claim.endpoint, key: claim.key }),
    );
  }
}

/** Proven failure before any provider call; a later retry is safe. */
export async function markDotHttpRequestFailedSafe(
  claim: DotHttpIdempotencyClaim,
): Promise<void> {
  await getDb().run(
    `UPDATE dot_http_idempotency
        SET status = 'failed_safe', updated_at = ?
      WHERE empresa_id = ? AND endpoint = ? AND idempotency_key = ?
        AND status = 'processing'`,
    [nowIso(), claim.empresaId, claim.endpoint, claim.key],
  );
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
        res.statusCode = 503;
        return originalJson({
          ok: false,
          error: 'O estado desta solicitação não pôde ser confirmado. A tentativa foi bloqueada para reconciliação.',
          code: 'DOT_IDEMPOTENCY_PERSIST_FAILED',
        });
      });
  }) as unknown as Response['json'];
}
