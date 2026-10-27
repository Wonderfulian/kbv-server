/**
 * Regression for the zod upgrade (2026-10-27, GHSA-mrhx-c7xc-m3w5: memory
 * exhaustion validating oversized constrained collections). The batch inputs
 * are exactly that shape — arrays capped at 100 — so the cap itself is pinned:
 * 100 entries are accepted on every batch surface, 101 are refused before any
 * upstream call.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createCache } from '../src/cache.js';
import { buildHsMasterFile, HsMaster } from '../src/hs-master.js';
import { buildMcpServer } from '../src/mcp.js';
import type { NtsClient } from '../src/nts.js';
import type { Deps } from '../src/service.js';
import type { TradeDeps } from '../src/import-requirements.js';

// 100 distinct well-formed business numbers and 100 distinct HS codes.
const NUMBERS = Array.from({ length: 100 }, (_, i) => String(2208162517 + i * 1001).padStart(10, '0').slice(0, 10));
const CODES = Array.from({ length: 100 }, (_, i) => `84713${String(i).padStart(5, '0')}`);

const MASTER = new HsMaster(
  buildHsMasterFile(
    [['HS부호', '적용시작일자', '적용종료일자', '한글품목명', '영문품목명'], ...CODES.map((c) => [c, '41275', '46387', '품목', 'Item'])],
    { source: 't', dataset: 'x', file_name: 'x', fetched_at: 'x' },
    1,
  ),
);

function deps(calls: { nts: number; customs: number }): Deps {
  const nts = {
    async checkStatus(b: string[]) {
      calls.nts += b.length;
      return b.map((b_no) => ({ b_no, b_stt_cd: '01', tax_type_cd: '01' }));
    },
    async validate() {
      return [];
    },
  } as unknown as NtsClient;
  const trade: TradeDeps = {
    customs: {
      async requirements() {
        calls.customs++;
        return [];
      },
    },
    today: () => '2026-10-27',
  };
  return { nts, cache: createCache(), hsMaster: async () => MASTER, trade };
}

describe('batch inputs at the cap of 100', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  it('MCP: both batch tools accept 100 entries and refuse 101 without calling upstream', async () => {
    const calls = { nts: 0, customs: 0 };
    const server = buildMcpServer(deps(calls), { tryConsume: () => true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(a), c.connect(b)]);

    const biz = await c.callTool({ name: 'check_korean_business_batch', arguments: { business_numbers: NUMBERS } });
    expect(biz.isError).toBeFalsy();
    expect((biz.structuredContent as { summary: { total: number } }).summary.total).toBe(100);
    const hs = await c.callTool({ name: 'check_korea_import_requirements_batch', arguments: { hs_codes: CODES } });
    expect(hs.isError).toBeFalsy();
    expect((hs.structuredContent as { summary: { checked: number } }).summary.checked).toBe(100);
    expect(calls).toEqual({ nts: 100, customs: 100 });

    const over1 = await c.callTool({ name: 'check_korean_business_batch', arguments: { business_numbers: [...NUMBERS, '1234567890'] } });
    const over2 = await c.callTool({ name: 'check_korea_import_requirements_batch', arguments: { hs_codes: [...CODES, CODES[0]] } });
    expect(over1.isError).toBe(true);
    expect(over2.isError).toBe(true);
    expect(calls).toEqual({ nts: 100, customs: 100 }); // nothing more went upstream
  });

  it('REST: both batch routes accept 100 entries and refuse 101 without calling upstream', async () => {
    const calls = { nts: 0, customs: 0 };
    const server = buildApp(deps(calls)).listen(0);
    servers.push(server);
    await new Promise<void>((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown) =>
      fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    expect((await post('/v1/business/batch', { business_numbers: NUMBERS })).status).toBe(200);
    const hs = await post('/v1/korea-import/requirements/batch', { hs_codes: CODES });
    expect(hs.status).toBe(200);
    expect(((await hs.json()) as { summary: { checked: number } }).summary.checked).toBe(100);
    expect(calls).toEqual({ nts: 100, customs: 100 });

    expect((await post('/v1/business/batch', { business_numbers: [...NUMBERS, '1234567890'] })).status).toBe(400);
    expect((await post('/v1/korea-import/requirements/batch', { hs_codes: [...CODES, CODES[0]] })).status).toBe(400);
    expect(calls).toEqual({ nts: 100, customs: 100 });
  });
});
