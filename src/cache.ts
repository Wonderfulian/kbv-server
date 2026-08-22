/**
 * In-memory LRU cache used purely as a resilience fallback: results are
 * written on every successful upstream call and read only when the NTS API
 * is unavailable, so fallback data is never older than the 24h TTL.
 */

import { createHash } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import type { StatusResult, VerifyResult } from './normalize.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

export interface CacheEntry<T> {
  result: T;
  /** checked_at of the original successful fetch, kept honest on fallback. */
  fetchedAt: string;
}

export type KbvCache = LRUCache<string, CacheEntry<StatusResult | VerifyResult>>;

export function createCache(): KbvCache {
  return new LRUCache({ max: MAX_ENTRIES, ttl: TTL_MS });
}

export function statusKey(businessNumber: string): string {
  return `status:${businessNumber}`;
}

/**
 * The verify params are hashed (DESIGN.md §6: number + param hash) — this
 * also keeps representative names out of key strings.
 */
export function verifyKey(
  businessNumber: string,
  params: { p_nm: string; start_dt: string; b_adr?: string },
): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([params.p_nm, params.start_dt, params.b_adr ?? '']))
    .digest('hex');
  return `verify:${businessNumber}:${hash}`;
}
