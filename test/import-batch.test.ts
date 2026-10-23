/**
 * Catalog screening (TRADE-DESK stage 6). What is pinned here:
 *   - invalid codes are classified before payment and never billed;
 *   - the free tier and the settlement come from one count (the 10/1 bug:
 *     the business batch exempted the test number from the quota but still
 *     settled it);
 *   - restricted codes first, then unchecked, then clear;
 *   - a code whose lookup failed is not charged.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { FacilitatorClient } from '@x402/core/server';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const settled: string[] = [];
vi.mock('@x402/express', async (orig) => {
  const real = await orig<typeof import('@x402/express')>();
  return {
    ...real,
    setSettlementOverrides: (_res: unknown, o: { amount: string }) => {
      settled.push(o.amount);
    },
  };
});

const { buildApp } = await import('../src/app.js');
const { createCache } = await import('../src/cache.js');
const { buildHsMasterFile, HsMaster } = await import('../src/hs-master.js');
const { hsGuard } = await import('../src/hs-guard.js');
const { classifyHsCodes, importRequirementsBatch, IMPORT_BATCH_PATH } = await import('../src/import-batch.js');
const { TEST_HS_CODE } = await import('../src/import-requirements.js');
const { buildMcpServer } = await import('../src/mcp.js');
const { buildRestRouter } = await import('../src/rest.js');
type TradeDeps = import('../src/import-requirements.js').TradeDeps;
type CustomsRequirementRow = import('../src/customs.js').CustomsRequirementRow;
type Deps = import('../src/service.js').Deps;
type NtsClient = import('../src/nts.js').NtsClient;

const row = (statuteCode: string, statuteName: string, agencyCode: string, agencyName: string, cert: string): CustomsRequirementRow => ({
  aplyStrtDt: '20200406',
  statuteCode,
  statuteName,
  agencyCode,
  agencyName,
  certificateName: cert,
});
const COFFEE = [row('23', '전기용품 및 생활용품 안전관리법', '105', '기술표준원', '전기용품 및 생활용품 요건확인서')];
const LAPTOP = [row('39', '전파법', '108', '국립전파연구원', '방송통신기기인증확인서')];

const MASTER = new HsMaster(
  buildHsMasterFile(
    [
      ['HS부호', '적용시작일자', '적용종료일자', '한글품목명', '영문품목명'],
      ['8516710000', '41275', '46387', '커피ㆍ차를 끓이는 기기', 'Coffee or tea makers'],
      ['7318152000', '41275', '46387', '볼트(bolt)', 'Bolts'],
      ['8471300000', '41275', '46387', '휴대용 컴퓨터', 'Portable computers'],
      ['8471410000', '41275', '46387', '기타 컴퓨터', 'Other computers'],
      ['6109100000', '41275', '46387', '면제 티셔츠', 'T-shirts of cotton'],
    ],
    { source: 't', dataset: 'x', file_name: 'x', fetched_at: 'x' },
    1,
  ),
);
const TODAY = '2026-10-23';

function trade(rows: Record<string, CustomsRequirementRow[] | Error>): TradeDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    customs: {
      async requirements(hs, direction) {
        calls.push(`${hs}:${direction}`);
        const r = rows[hs] ?? [];
        if (r instanceof Error) throw r;
        return r;
      },
    },
    today: () => TODAY,
    now: () => new Date(`${TODAY}T00:00:00Z`),
  };
}

describe('classifyHsCodes', () => {
  it('sets invalid codes aside with the reason, merges duplicates, and bills neither them nor the test code', () => {
    const b = classifyHsCodes(MASTER, ['8471.30-0000', '9999999999', '847141', 'abc', '8471300000', TEST_HS_CODE, '7318152000'], TODAY);
    expect(b.valid.map((v) => v.hs_code)).toEqual(['8471300000', TEST_HS_CODE, '7318152000']);
    expect(b.invalid.map((i) => [i.index, i.error])).toEqual([
      [1, 'hs_code_not_found'],
      [2, 'hs_code_incomplete'],
      [3, 'invalid_input'],
    ]);
    expect(b.invalid[1].candidates?.map((c) => c.hs_code)).toEqual(['8471410000']);
    expect(b.duplicates).toBe(1);
    expect(b.billable).toBe(2); // laptop + bolt; not the test code, not the invalid ones, not the duplicate
  });
});

describe('importRequirementsBatch', () => {
  it('puts restricted codes first, then unchecked, then clear — and charges only completed, non-test lookups', async () => {
    const deps = trade({ '8516710000': COFFEE, '8471300000': LAPTOP, '6109100000': new Error('down') });
    const b = classifyHsCodes(MASTER, ['7318152000', '6109100000', TEST_HS_CODE, 'nope', '8471300000'], TODAY);
    const out = await importRequirementsBatch(deps, b, 'import', { full: true });
    expect(out.status).toBe(200);
    const results = out.body.results as Record<string, unknown>[];
    expect(results.map((r) => r.hs_code)).toEqual([TEST_HS_CODE, '8471300000', '6109100000', '7318152000']);
    expect(results[2]).toMatchObject({ requirements_checked: false });
    expect(out.body.summary).toMatchObject({
      total: 5,
      checked: 3,
      with_requirements: 2,
      clear: 1,
      failed: 1,
      duplicates_merged: 0,
      invalid_hs: [{ index: 3, input: 'nope', error: 'invalid_input' }],
    });
    expect(out.charged).toBe(2); // laptop + bolt: the test code is free, the failed T-shirt lookup is not charged
    // Stated once, not on every item.
    expect(out.body).toHaveProperty('disclaimer');
    for (const r of results) expect(r).not.toHaveProperty('disclaimer');
  });

  it('is an error, charging nothing, when no lookup completed', async () => {
    const deps = trade({ '7318152000': new Error('down'), '8471300000': new Error('down') });
    const out = await importRequirementsBatch(deps, classifyHsCodes(MASTER, ['7318152000', '8471300000'], TODAY), 'import', { full: true });
    expect(out.status).toBe(503);
    expect(out.charged).toBe(0);
    expect(out.body).toMatchObject({ error: 'upstream_unavailable' });
  });

  it('gives the free tier summaries, the test code in full', async () => {
    const deps = trade({ '8516710000': COFFEE, '8471300000': LAPTOP });
    const out = await importRequirementsBatch(deps, classifyHsCodes(MASTER, ['8471300000', TEST_HS_CODE], TODAY), 'import', { full: false });
    const [a, b] = out.body.results as Record<string, unknown>[];
    expect(out.body.detail).toBe('summary');
    expect(a).toMatchObject({ hs_code: '8471300000', has_requirements: true });
    expect(a).not.toHaveProperty('requirements');
    expect(b).toHaveProperty('requirements');
  });
});

const facilitator = {
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }, { x402Version: 2, scheme: 'upto', network: 'eip155:84532' }] };
  },
  async verify(): Promise<never> {
    throw new Error('verify must not be called');
  },
  async settle(): Promise<never> {
    throw new Error('settle must not be called');
  },
} as unknown as FacilitatorClient;

describe('REST route', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    settled.length = 0;
  });
  async function listen(app: express.Express) {
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((r) => server.once('listening', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}${IMPORT_BATCH_PATH}`;
  }
  async function start(tier = 10) {
    const t = trade({ '8516710000': COFFEE, '8471300000': LAPTOP });
    const deps: Deps = { nts: {} as NtsClient, cache: createCache(), hsMaster: async () => MASTER, trade: t };
    const url = await listen(
      buildApp(deps, { payTo: '0x0000000000000000000000000000000000000001', facilitatorUrl: 'http://127.0.0.1:1', network: 'eip155:84532', dailyFreeTier: tier, facilitatorClient: facilitator, tradeDesk: true }),
    );
    return { url, t };
  }
  const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('answers 402 to an unpaid batch before calling the upstream', async () => {
    const { url, t } = await start();
    const res = await post(url, { hs_codes: ['8471300000', '7318152000'] });
    expect(res.status).toBe(402);
    expect(t.calls).toEqual([]);
  });

  it('refuses for free, before payment, a batch with no valid code or more than 100', async () => {
    const { url, t } = await start();
    const none = await post(url, { hs_codes: ['9999999999', '1234'] });
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ error: 'no_valid_hs_codes', invalid_hs: [{ index: 0 }, { index: 1 }] });
    expect((await post(url, { hs_codes: Array.from({ length: 101 }, () => '8471300000') })).status).toBe(400);
    expect((await post(url, { hs_codes: '8471300000' })).status).toBe(400);
    expect((await post(url, { hs_codes: ['8471300000'], direction: 'sideways' })).status).toBe(400);
    expect(t.calls).toEqual([]);
  });

  it('needs no payment for a batch of only the test code and invalid codes', async () => {
    const { url } = await start(0); // no free tier at all
    const res = await post(url, { hs_codes: [TEST_HS_CODE, '9999999999'] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { summary: { invalid_hs: unknown[] } }).summary.invalid_hs).toHaveLength(1);
  });

  it('spends the free tier by the same count it would bill: valid, non-test codes only', async () => {
    const { url } = await start(2);
    // 2 billable (laptop, bolt) + test code + invalid + duplicate: exactly the tier of 2.
    const ok = await post(`${url}?free=1`, { hs_codes: ['8471300000', '7318152000', TEST_HS_CODE, '9999999999', '8471300000'] });
    expect(ok.status).toBe(200);
    // The tier is now spent.
    expect((await post(`${url}?free=1`, { hs_codes: ['8471300000'] })).status).toBe(402);
  });

  it('settles $0.02 per completed, non-test lookup — invalid, test and failed codes excluded', async () => {
    const t = trade({ '8516710000': COFFEE, '8471300000': LAPTOP, '6109100000': new Error('down') });
    const deps: Deps = { nts: {} as NtsClient, cache: createCache(), trade: t };
    const app = express();
    app.use(express.json());
    app.use(hsGuard({ loadMaster: async () => MASTER, today: () => TODAY }));
    app.use((_req, res, next) => {
      res.locals.paid = true; // as the payment middleware leaves it after a verified payment
      next();
    });
    app.use(buildRestRouter(deps));
    const url = await listen(app);
    const res = await post(url, { hs_codes: ['8471300000', '7318152000', '6109100000', TEST_HS_CODE, '9999999999', '847141'] });
    expect(res.status).toBe(200);
    expect(settled).toEqual(['40000']); // laptop + bolt
  });
});

describe('MCP tool', () => {
  async function client(tryConsume: (u: number) => boolean) {
    const t = trade({ '8516710000': COFFEE, '8471300000': LAPTOP });
    const server = buildMcpServer({ nts: {} as NtsClient, cache: createCache(), hsMaster: async () => MASTER, trade: t }, { tryConsume });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(a), c.connect(b)]);
    return { c, t };
  }

  it('spends one lookup per valid, non-test code and returns full detail, restricted first', async () => {
    const used: number[] = [];
    const { c } = await client((u) => (used.push(u), true));
    const r = await c.callTool({ name: 'check_korea_import_requirements_batch', arguments: { hs_codes: ['7318152000', TEST_HS_CODE, '8471300000', 'x1'] } });
    const body = r.structuredContent as { results: Record<string, unknown>[]; summary: Record<string, unknown> };
    expect(used).toEqual([2]);
    expect(body.results.map((x) => x.hs_code)).toEqual([TEST_HS_CODE, '8471300000', '7318152000']);
    expect(body.results[1]).toHaveProperty('requirements');
    expect(body.summary.invalid_hs).toHaveLength(1);
  });

  it('spends nothing and calls nothing when no code is valid', async () => {
    const used: number[] = [];
    const { c, t } = await client((u) => (used.push(u), true));
    const r = await c.callTool({ name: 'check_korea_import_requirements_batch', arguments: { hs_codes: ['9999999999'] } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('no_valid_hs_codes');
    expect(used).toEqual([]);
    expect(t.calls).toEqual([]);
  });
});
