/** Buffer em memória de rate-limits (RPM/TPM) da IA. */

const rateLimitHits: { at: number; provider: string; detail: string }[] = [];
const MAX_HITS = 100;

export function recordRateLimitHit(provider: string, detail: string) {
  rateLimitHits.unshift({
    at: Date.now(),
    provider: String(provider).slice(0, 20),
    detail: String(detail).slice(0, 300),
  });
  if (rateLimitHits.length > MAX_HITS) rateLimitHits.length = MAX_HITS;
}

export function isRateLimitError(err: any): boolean {
  const status = Number(err?.status || 0);
  if (status === 429) return true;
  const b = String(err?.body || err?.message || '').toLowerCase();
  return (
    b.includes('rate limit') ||
    b.includes('rate_limit') ||
    b.includes('too many requests') ||
    b.includes('tokens per minute') ||
    b.includes('requests per minute') ||
    b.includes('tpm') ||
    b.includes('rpm')
  );
}

export function getRateLimitHits() {
  return rateLimitHits;
}
