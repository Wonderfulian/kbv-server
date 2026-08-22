import { describe, expect, it, vi } from 'vitest';
import { createNtsClient, MAX_BATCH, NtsError } from '../src/nts.js';

const KEY = 'test-service-key+/=';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const STATUS_ITEM = { b_no: '1234567890', b_stt_cd: '01', tax_type_cd: '01' };

describe('checkStatus', () => {
  it('POSTs { b_no: [...] } to /status with the encoded serviceKey', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [STATUS_ITEM] }));
    const client = createNtsClient({ serviceKey: KEY, fetchImpl });

    const items = await client.checkStatus(['1234567890']);

    expect(items).toEqual([STATUS_ITEM]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/status?');
    expect(new URL(url).searchParams.get('serviceKey')).toBe(KEY);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ b_no: ['1234567890'] });
  });

  it('rejects batches over the NTS limit before any network call', async () => {
    const fetchImpl = vi.fn();
    const client = createNtsClient({ serviceKey: KEY, fetchImpl });

    const tooMany = Array.from({ length: MAX_BATCH + 1 }, () => '1234567890');
    await expect(client.checkStatus(tooMany)).rejects.toMatchObject({ kind: 'batch_limit' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('validate', () => {
  it('POSTs { businesses: [...] } including optional b_adr', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [{ b_no: '1234567890', valid: '01' }] }));
    const client = createNtsClient({ serviceKey: KEY, fetchImpl });

    const results = await client.validate([
      { b_no: '1234567890', start_dt: '19990501', p_nm: '홍길동', b_adr: '서울특별시 강남구' },
    ]);

    expect(results[0]).toEqual({ b_no: '1234567890', valid: '01' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/validate?');
    expect(JSON.parse(init.body as string)).toEqual({
      businesses: [{ b_no: '1234567890', start_dt: '19990501', p_nm: '홍길동', b_adr: '서울특별시 강남구' }],
    });
  });

  it('enforces the batch limit too', async () => {
    const fetchImpl = vi.fn();
    const client = createNtsClient({ serviceKey: KEY, fetchImpl });

    const tooMany = Array.from({ length: MAX_BATCH + 1 }, () => ({
      b_no: '1234567890',
      start_dt: '19990501',
      p_nm: 'x',
    }));
    await expect(client.validate(tooMany)).rejects.toMatchObject({ kind: 'batch_limit' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('retry behavior', () => {
  it('retries once after a network error, then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ data: [STATUS_ITEM] }));
    const client = createNtsClient({ serviceKey: KEY, fetchImpl });

    await expect(client.checkStatus(['1234567890'])).resolves.toEqual([STATUS_ITEM]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries once after a 5xx, then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'oops' }, 500))
      .mockResolvedValueOnce(jsonResponse({ data: [STATUS_ITEM] }));
    const client = createNtsClient({ serviceKey: KEY, fetchImpl });

    await expect(client.checkStatus(['1234567890'])).resolves.toEqual([STATUS_ITEM]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after exactly two attempts', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const client = createNtsClient({ serviceKey: KEY, fetchImpl });

    await expect(client.checkStatus(['1234567890'])).rejects.toBeInstanceOf(NtsError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 429 (quota) — fails fast toward the cache fallback', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'quota' }, 429));
    const client = createNtsClient({ serviceKey: KEY, fetchImpl });

    await expect(client.checkStatus(['1234567890'])).rejects.toMatchObject({ kind: 'quota', status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on other 4xx errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'bad key' }, 401));
    const client = createNtsClient({ serviceKey: KEY, fetchImpl });

    await expect(client.checkStatus(['1234567890'])).rejects.toMatchObject({ kind: 'http', status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('response validation', () => {
  it('throws an http error when the body is not JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>gateway error</html>', { status: 200 }));
    const client = createNtsClient({ serviceKey: KEY, fetchImpl });

    await expect(client.checkStatus(['1234567890'])).rejects.toMatchObject({ kind: 'http' });
  });

  it('throws an http error when data is missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ unexpected: true }));
    const client = createNtsClient({ serviceKey: KEY, fetchImpl });

    await expect(client.checkStatus(['1234567890'])).rejects.toMatchObject({ kind: 'http' });
  });

  it('never leaks the service key or query contents in error messages', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'x' }, 500));
    const client = createNtsClient({ serviceKey: KEY, fetchImpl });

    const err = await client.checkStatus(['9876543210']).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(KEY);
    expect((err as Error).message).not.toContain('9876543210');
  });
});
