/**
 * Retry for flaky upstream connections.
 *
 * Only failures that say nothing about the request itself are retried:
 * network errors and 5xx. A rejected credential, a bad parameter or a quota
 * refusal will not get better by asking again — and retrying a rejected
 * credential is how a perfectly good setting gets "fixed" by mistake. On
 * 2026-10-21 the first law.go.kr call from Cloud Run failed with a network
 * error and the same call succeeded three minutes later.
 */

export class RetryableError extends Error {}

export interface RetryOptions {
  /** Extra attempts after the first (default 2 → 3 attempts in all). */
  retries?: number;
  /** First back-off in ms, doubled each time (default 400). */
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const baseMs = opts.baseMs ?? 400;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!(err instanceof RetryableError) || attempt >= retries) throw err;
      await sleep(baseMs * 2 ** attempt);
    }
  }
}
