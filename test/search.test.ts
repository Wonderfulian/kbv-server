/**
 * Search service and route tiers. The tier boundary is the point of the
 * feature — finding is free, confirming is paid — so most of these tests are
 * about what each tier does and does not disclose.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createCache } from '../src/cache.js';
import type { DartClient } from '../src/dart.js';
import type { NameIndexEntry } from '../src/name-index.js';
import type { NtsClient } from '../src/nts.js';
import { memoizeIndex, searchBusinesses } from '../src/search.js';
import type { Deps } from '../src/service.js';

const INDEX: NameIndexEntry[] = [
  {
    business_number: '1248100998',
    name: '삼성전자(주)',
    name_en: 'SAMSUNG ELECTRONICS CO,.LTD',
    corp_code: '00126380',
    listed: true,
    source: 'dart',
  },
  { name: '삼성전자판매', name_en: 'SAMSUNG ELECTRONICS SALES Co., Ltd.', corp_code: '00252074', source: 'dart' },
  { business_number: '2208162517', name: '삼성전자우호기업', region: '경기도 김포시', source: 'g2b' },
];

const nts: NtsClient = {
  async checkStatus(bNos) {
    return bNos.map((b) => ({ b_no: b, b_stt_cd: '01', tax_type_cd: '01' }));
  },
  async validate() {
    return [];
  },
};

const loadIndex = async () => INDEX.map((e) => ({ ...e }));

describe('search tiers', () => {
  it('basic tier returns identity and confidence, no evidence', async () => {
    const out = await searchBusinesses({ loadIndex, nts }, 'Samsung Electronics');
    expect(out.candidates[0]).toMatchObject({ business_number: '1248100998', confidence: expect.any(Number) });
    expect(out.candidates[0].evidence).toBeUndefined();
    expect(out.source).toBeUndefined();
  });

  it('full tier adds status, tax type, region and listing', async () => {
    const out = await searchBusinesses({ loadIndex, nts }, '삼성전자', { full: true });
    const top = out.candidates[0];
    expect(top.evidence).toMatchObject({ status: 'active', tax_type: 'general', listed: true });
    const vendor = out.candidates.find((c) => c.business_number === '2208162517');
    expect(vendor?.evidence?.region).toBe('경기도 김포시');
    expect(out.source).toContain('National Tax Service');
  });

  it('states the ambiguity when several companies tie', async () => {
    const out = await searchBusinesses({ loadIndex, nts }, '삼성전자');
    expect(out.candidates.length).toBeGreaterThan(1);
  });

  it('returns an empty list rather than a guess for an unknown name', async () => {
    const out = await searchBusinesses({ loadIndex, nts }, 'Totally Unknown Corp');
    expect(out.candidates).toEqual([]);
  });

  it('says an empty result is definitive, so it cannot be read as a failure', async () => {
    const out = await searchBusinesses({ loadIndex, nts }, 'Totally Unknown Corp');
    expect(out.note).toMatch(/definitive empty result, not an error/);
    expect(out.note).toMatch(/DART|procurement/);
  });
});

describe('lazy number resolution', () => {
  it('resolves a missing number through DART and memoizes it', async () => {
    const calls: string[] = [];
    const dart = {
      async fetchCorpCodes() {
        return [];
      },
      async fetchBusinessNumber(code: string) {
        calls.push(code);
        return '1111111111';
      },
    } as DartClient;
    const resolved = new Map<string, string>();

    const first = await searchBusinesses({ loadIndex, nts, dart, resolved }, 'Samsung Electronics Sales');
    expect(first.candidates[0].business_number).toBe('1111111111');
    await searchBusinesses({ loadIndex, nts, dart, resolved }, 'Samsung Electronics Sales');
    expect(calls).toEqual(['00252074']); // second search used the memo
  });

  it('keeps the candidate when DART fails, just without a number', async () => {
    const dart = {
      async fetchCorpCodes() {
        return [];
      },
      async fetchBusinessNumber() {
        throw new Error('DART 020 rate limited');
      },
    } as DartClient;
    const out = await searchBusinesses({ loadIndex, nts, dart }, 'Samsung Electronics Sales');
    expect(out.candidates[0].name).toBe('삼성전자판매');
    expect(out.candidates[0].business_number).toBeNull();
  });

  it('degrades evidence rather than the result when the upstream is down', async () => {
    const broken: NtsClient = {
      async checkStatus() {
        throw new Error('upstream 503');
      },
      async validate() {
        return [];
      },
    };
    const out = await searchBusinesses({ loadIndex, nts: broken }, 'Samsung Electronics', { full: true });
    expect(out.candidates[0].business_number).toBe('1248100998');
    expect(out.candidates[0].evidence?.status).toBeUndefined();
  });
});

describe('memoizeIndex', () => {
  it('loads once, and retries after a failure', async () => {
    let loads = 0;
    const load = memoizeIndex(async () => {
      loads++;
      if (loads === 1) throw new Error('bucket unavailable');
      return INDEX;
    });
    await expect(load()).rejects.toThrow(/bucket unavailable/);
    expect(await load()).toHaveLength(3);
    expect(await load()).toHaveLength(3);
    expect(loads).toBe(2); // failure not cached, success cached
  });
});

describe('GET /v1/business/search', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())))),
    );
  });

  async function start(deps: Deps): Promise<string> {
    const server = buildApp(deps).listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const searchDeps: Deps = {
    nts,
    cache: createCache(),
    search: (query, opts) => searchBusinesses({ loadIndex, nts }, query, opts),
  };

  it('answers a name query without payment configured', async () => {
    const base = await start(searchDeps);
    const res = await fetch(`${base}/v1/business/search?q=Samsung%20Electronics`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: { business_number: string }[] };
    expect(body.candidates[0].business_number).toBe('1248100998');
  });

  it('requires a query', async () => {
    const base = await start(searchDeps);
    const res = await fetch(`${base}/v1/business/search`);
    expect(res.status).toBe(400);
  });

  it('answers 503 when no index is configured, instead of pretending it is empty', async () => {
    const base = await start({ nts, cache: createCache() });
    const res = await fetch(`${base}/v1/business/search?q=Samsung`);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('search_unavailable');
  });

  it('separates "no such company" (200, empty) from "lookup failed" (503)', async () => {
    const base = await start(searchDeps);
    const empty = await fetch(`${base}/v1/business/search?q=Nonexistent%20Company%20Xyz`);
    expect(empty.status).toBe(200);
    const body = (await empty.json()) as { candidates: unknown[]; note?: string; error?: string };
    expect(body.candidates).toEqual([]);
    expect(body.error).toBeUndefined(); // an answer, not an error
    expect(body.note).toBeTruthy();

    const broken = await start({
      nts,
      cache: createCache(),
      search: async () => {
        throw new Error('index bucket unreachable');
      },
    });
    const failed = await fetch(`${broken}/v1/business/search?q=Samsung`);
    expect(failed.status).toBe(503);
    expect((await failed.json()).error).toBe('upstream_unavailable');
  });
});
