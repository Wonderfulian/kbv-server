import { describe, expect, it } from 'vitest';
import { createCache, statusKey, verifyKey } from '../src/cache.js';
import type { StatusResult } from '../src/normalize.js';

const RESULT: StatusResult = {
  business_number: '1234567890',
  status: 'active',
  status_code_raw: '01',
  tax_type: 'general',
  closed_date: null,
  checked_at: '2026-08-22T09:00:00.000Z',
  source: 'Korea National Tax Service (NTS)',
  cache: false,
};

describe('createCache', () => {
  it('stores and returns entries', () => {
    const cache = createCache();
    cache.set(statusKey('1234567890'), { result: RESULT, fetchedAt: RESULT.checked_at });
    expect(cache.get(statusKey('1234567890'))?.result.status).toBe('active');
  });

  it('is configured with a 24h TTL', () => {
    expect(createCache().ttl).toBe(24 * 60 * 60 * 1000);
  });

  it('expires entries once their TTL elapses', async () => {
    // lru-cache reads performance.now() through a reference captured at
    // module load, so fake timers can't reach it — verify real expiry with a
    // short per-entry TTL override instead (the 24h default is asserted above).
    const cache = createCache();
    cache.set(statusKey('1234567890'), { result: RESULT, fetchedAt: RESULT.checked_at }, { ttl: 30 });

    expect(cache.get(statusKey('1234567890'))).toBeDefined();
    await new Promise((r) => setTimeout(r, 60));
    expect(cache.get(statusKey('1234567890'))).toBeUndefined();
  });
});

describe('cache keys', () => {
  it('statusKey is namespaced by business number', () => {
    expect(statusKey('1234567890')).toBe('status:1234567890');
  });

  it('verifyKey is deterministic for identical params', () => {
    const a = verifyKey('1234567890', { p_nm: '홍길동', start_dt: '19990501' });
    const b = verifyKey('1234567890', { p_nm: '홍길동', start_dt: '19990501' });
    expect(a).toBe(b);
  });

  it('verifyKey changes when any param (including address) differs', () => {
    const base = verifyKey('1234567890', { p_nm: '홍길동', start_dt: '19990501' });
    expect(verifyKey('1234567890', { p_nm: '김철수', start_dt: '19990501' })).not.toBe(base);
    expect(verifyKey('1234567890', { p_nm: '홍길동', start_dt: '20000101' })).not.toBe(base);
    expect(verifyKey('1234567890', { p_nm: '홍길동', start_dt: '19990501', b_adr: '서울' })).not.toBe(base);
  });

  it('never embeds the representative name in the key (privacy)', () => {
    const key = verifyKey('1234567890', { p_nm: '홍길동', start_dt: '19990501', b_adr: '서울특별시' });
    expect(key).not.toContain('홍길동');
    expect(key).not.toContain('서울');
    expect(key).toMatch(/^verify:1234567890:[0-9a-f]{64}$/);
  });
});
