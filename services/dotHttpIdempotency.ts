/**
 * Durable HTTP idempotency for stateful Filtra Dot requests.
 *
 * The unique database key is scoped by tenant + endpoint. A request is claimed
 * before context/cache reads or provider work. Completed responses are replayed
 * byte-for-byte at the JSON/status level; mismatched payloads and concurrent or
 * ambiguous retries fail closed and never start a second provider call.
 */
import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { getDb, withDbTransaction } from '../lib/db.js';

const PENDING_STALE_MS = 15 * 60_000;
const COMPLETED_TTL_MS = 24 * 60 * 60_000;

type IdempotencyRow = {
  tenant_id: string;
  endpoint: string;
  idempotency_key: string;
  request_hash: string;
  status: 'pending' | 'completed' | 'ambiguous';
  response_status: number | null;
  response_body: string | null;
  created_at: string;
  updated_at: string;
};

export type DotHttpIdempotencyClaim = {
  tenantId: string;
  endpoint: string;
  key: string;
  requestHash: string;
};

export type DotHttpIdempotencyResult =
  | { kind: 'claimed'; claim: DotHttpIdempotencyClaim }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'in_progress' }
  | { kind: 'ambiguous' }
  | { kind: 'payload_mismatch' };

export function hashDotHttpPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export async function claimDotHttpRequest(input: {
  tenantId: string;
  endpoint: string;
  key: string;
  payload: unknown;
}): Promise<DotHttpIdempotencyResult> {
  const tenantId = String(input.tenantId || '').trim();
  const endpoint = String(input.endpoint || '').trim();
  const key = String(input.key || '').trim();
  if (!tenantId || !endpoint || !key || key.length > 128) {
    throw new Error('Invalid Dot HTTP idempotency scope or key');
  }

  const claim: DotHttpIdempotencyClaim = {
    tenantId,
    endpoint,
    key,
    requestHash: hashDotHttpPayload(input.payload),
  };
  const now = new Date();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - PENDING_STALE_MS).toISOString();

  return withDbTransaction(async (tx) => {
    // Only completed records are eligible for retention cleanup. Pending and
    // ambiguous rows are safety records and are never silently discarded.
    await tx.run(
      `DELETE FROM dot_http_idempotency
        WHERE status = 'completed' AND expires_at < ?`,
      [nowIso],
    );

    const inserted = await tx.run(
      `INSERT OR IGNORE INTO dot_http_idempotency
        (tenant_id, endpoint, idempotency_key, request_hash, status, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        tenantId,
        endpoint,
        key,
        claim.requestHash,
        nowIso,
        nowIso,
        new Date(now.getTime() + COMPLETED_TTL_MS).toISOString(),
      ],
    );
    if (inserted.changes === 1) return { kind: 'claimed', claim };

    const existing = await tx.get<IdempotencyRow>(
      `SELECT tenant_id, endpoint, idempotency_key, request_hash, status,
              response_status, response_body, created_at, updated_at
         FROM dot_http_idempotency
        WHERE tenant_id = ? AND endpoint = ? AND idempotency_key = ?`,
      [tenantId, endpoint, key],
    );
    if (!existing) throw new Error('Dot HTTP idempotency row disappeared after unique conflict');
    if (existing.request_hash !== claim.requestHash) return { kind: 'payload_mismatch' };
    if (existing.status === 'completed') {
      if (!existing.response_body || !existing.response_status) {
        throw new Error('Completed Dot HTTP idempotency row has no stored response');
      }
      return {
        kind: 'replay',
        status: Number(existing.response_status),
        body: JSON.parse(existing.response_body),
      };
    }
    if (existing.status === 'ambiguous') return { kind: 'ambiguous' };

    if (existing.updated_at < staleBefore) {
      const staleTransition = await tx.run(
        `UPDATE dot_http_idempotency
            SET status = 'ambiguous', updated_at = ?
          WHERE tenant_id = ? AND endpoint = ? AND idempotency_key = ?
            AND status = 'pending' AND updated_at = ?`,
        [nowIso, tenantId, endpoint, key, existing.updated_at],
      );
      if (staleTransition.changes === 1) return { kind: 'ambiguous' };

      // A request may have completed between the read and stale transition.
      // Re-read instead of incorrectly hiding a committed response.
      const raced = await tx.get<IdempotencyRow>(
        `SELECT tenant_id, endpoint, idempotency_key, request_hash, status,
                response_status, response_body, created_at, updated_at
           FROM dot_http_idempotency
          WHERE tenant_id = ? AND endpoint = ? AND idempotency_key = ?`,
        [tenantId, endpoint, key],
      );
      if (raced?.status === 'completed' && raced.response_body && raced.response_status) {
        return { kind: 'replay', status: Number(raced.response_status), body: JSON.parse(raced.response_body) };
      }
      return raced?.status === 'ambiguous' ? { kind: 'ambiguous' } : { kind: 'in_progress' };
    }
    // A concurrent request is still running. It must not acquire a second
    // provider reservation or execute another call.
    return { kind: 'in_progress' };
  });
}

export async function completeDotHttpRequest(
  claim: DotHttpIdempotencyClaim,
  status: number,
  body: unknown,
): Promise<boolean> {
  const serialized = JSON.stringify(body);
  if (serialized === undefined || serialized.length > 256_000) {
    await markDotHttpRequestAmbiguous(claim);
    return false;
  }
  const now = new Date().toISOString();
  const result = await getDb().run(
    `UPDATE dot_http_idempotency
        SET status = 'completed', response_status = ?, response_body = ?,
            updated_at = ?, expires_at = ?
      WHERE tenant_id = ? AND endpoint = ? AND idempotency_key = ? AND status = 'pending'`,
    [
      status,
      serialized,
      now,
      new Date(Date.now() + COMPLETED_TTL_MS).toISOString(),
      claim.tenantId,
      claim.endpoint,
      claim.key,
    ],
  );
  return result.changes === 1;
}

export async function markDotHttpRequestAmbiguous(
  claim: DotHttpIdempotencyClaim,
): Promise<void> {
  await getDb().run(
    `UPDATE dot_http_idempotency
        SET status = 'ambiguous', updated_at = ?
      WHERE tenant_id = ? AND endpoint = ? AND idempotency_key = ? AND status = 'pending'`,
    [new Date().toISOString(), claim.tenantId, claim.endpoint, claim.key],
  );
}

/**
 * Persist the response before sending it. A 5xx is conservatively marked
 * ambiguous because the caller cannot prove whether the provider was reached.
 */
export function persistDotHttpResponse(res: Response, claim: DotHttpIdempotencyClaim): void {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    const status = res.statusCode || 200;
    const persist = status >= 500
      ? markDotHttpRequestAmbiguous(claim).then(() => true)
      : completeDotHttpRequest(claim, status, body);

    return persist.then((saved) => {
      if (!saved) {
        res.statusCode = 503;
        return originalJson({
          ok: false,
          error: 'Não foi possível persistir a resposta com segurança. A tentativa não será repetida automaticamente.',
          code: 'DOT_IDEMPOTENCY_PERSIST_FAILED',
        });
      }
      return originalJson(body);
    }).catch((error) => {
      console.error('[dot-idempotency] falha ao persistir resposta:', String(error?.message || error));
      res.statusCode = 503;
      return originalJson({
        ok: false,
        error: 'O estado desta solicitação não pôde ser confirmado. A tentativa foi bloqueada para reconciliação.',
        code: 'DOT_IDEMPOTENCY_PERSIST_FAILED',
      });
    });
  }) as Response['json'];
}
