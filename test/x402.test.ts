/**
 * Free-tier + x402 gating tests. No facilitator network access anywhere:
 * syncFacilitatorOnStart is false and no test ever submits a real payment —
 * we assert the 402 boundary, not settlement (that's the testnet E2E step).
 *
 * Key property under test: REST and MCP share one per-IP counter, and
 * over-quota MCP returns a plain error pointing at the paid REST API
 * (never a 402), closing the "free MCP forever" bypass.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FacilitatorClient } from '@x402/core/server';
import { buildApp, type X402Options } from '../src/app.js';
import { createCache } from '../src/cache.js';
import { createQuota } from '../src/quota.js';
import { NtsError, type NtsClient, type NtsStatusItem } from '../src/nts.js';
import type { Deps } from '../src/service.js';

const A = '1234567890';

/**
 * Offline facilitator stand-in: reports exact+upto support on Base Sepolia
 * (what the middleware needs to build 402 responses) and fails hard if any
 * test ever reaches verify/settle.
 */
const fakeFacilitator = {
  async getSupported() {
    return {
      kinds: [
        { x402Version: 2, scheme: 'exact', network: 'eip155:84532' },
        { x402Version: 2, scheme: 'upto', network: 'eip155:84532' },
      ],
    };
  },
  async verify(): Promise<never> {
    throw new Error('verify must not be called in these tests');
  },
  async settle(): Promise<never> {
    throw new Error('settle must not be called in these tests');
  },
} as unknown as FacilitatorClient;

describe('createQuota', () => {
  it('allows up to the daily limit and then refuses', () => {
    const quota = createQuota(10);
    expect(quota.tryConsume('ip1', 8)).toBe(true);
    expect(quota.tryConsume('ip1', 2)).toBe(true);
    expect(quota.tryConsume('ip1', 1)).toBe(false);
  });

  it('refuses an oversized consume without burning the remainder', () => {
    const quota = createQuota(10);
    expect(quota.tryConsume('ip1', 7)).toBe(true);
    expect(quota.tryConsume('ip1', 4)).toBe(false); // 7+4 > 10 — nothing consumed
    expect(quota.tryConsume('ip1', 3)).toBe(true); // exactly reaches 10
  });

  it('tracks IPs independently', () => {
    const quota = createQuota(1);
    expect(quota.tryConsume('ip1', 1)).toBe(true);
    expect(quota.tryConsume('ip2', 1)).toBe(true);
    expect(quota.tryConsume('ip1', 1)).toBe(false);
  });

  it('resets at the UTC day boundary', () => {
    let day = '2026-08-27';
    const quota = createQuota(1, () => new Date(`${day}T23:59:00Z`));
    expect(quota.tryConsume('ip1', 1)).toBe(true);
    expect(quota.tryConsume('ip1', 1)).toBe(false);
    day = '2026-08-28';
    expect(quota.tryConsume('ip1', 1)).toBe(true);
  });
});

describe('free tier + x402 gating', () => {
  let server: Server;
  let baseUrl: string;
  let state: { statusItems: NtsStatusItem[]; error: NtsError | null; statusCalls: string[][] };

  const X402: X402Options = {
    payTo: '0x0000000000000000000000000000000000000001', // placeholder for tests only
    facilitatorUrl: 'http://127.0.0.1:1', // must never be contacted
    network: 'eip155:84532',
    dailyFreeTier: 10,
    facilitatorClient: fakeFacilitator,
  };

  beforeEach(async () => {
    state = { statusItems: [{ b_no: A, b_stt_cd: '01', tax_type_cd: '01' }], error: null, statusCalls: [] };
    const nts: NtsClient = {
      async checkStatus(bNos) {
        state.statusCalls.push(bNos);
        if (state.error) throw state.error;
        return bNos.map((b) => ({ ...state.statusItems[0], b_no: b }));
      },
      async validate(items) {
        return items.map((i) => ({ b_no: i.b_no, valid: '01' as const }));
      },
    };
    const deps: Deps = { nts, cache: createCache() };
    const app = buildApp(deps, X402);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  function getStatus(ip?: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/business/${A}/status`, {
      headers: ip ? { 'X-Forwarded-For': ip } : {},
    });
  }

  it('serves the free tier, then returns 402 with payment requirements', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await getStatus()).status).toBe(200);
    }
    const eleventh = await getStatus();

    expect(eleventh.status).toBe(402);
    expect(eleventh.headers.get('payment-required')).toBeTruthy();
    // The upstream was queried exactly 10 times — the 402 call never reached NTS.
    expect(state.statusCalls).toHaveLength(10);
  });

  it('meters per IP — another client still gets the free tier', async () => {
    for (let i = 0; i < 10; i++) await getStatus('198.51.100.1');
    expect((await getStatus('198.51.100.1')).status).toBe(402);
    expect((await getStatus('203.0.113.9')).status).toBe(200);
  });

  it('batch consumes one unit per number', async () => {
    const batch = await fetch(`${baseUrl}/v1/business/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_numbers: Array.from({ length: 8 }, () => A) }),
    });
    expect(batch.status).toBe(200);

    expect((await getStatus()).status).toBe(200); // 9
    expect((await getStatus()).status).toBe(200); // 10
    expect((await getStatus()).status).toBe(402); // over
  });

  it('an over-limit batch costs nothing and is rejected as before', async () => {
    const over = await fetch(`${baseUrl}/v1/business/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_numbers: Array.from({ length: 101 }, () => A) }),
    });
    expect(over.status).toBe(400);
    expect((await getStatus()).status).toBe(200); // quota untouched
  });

  it('unmetered routes stay free at any usage level', async () => {
    for (let i = 0; i < 10; i++) await getStatus();
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it('MCP shares the counter and over-quota returns guidance, not 402', async () => {
    for (let i = 0; i < 10; i++) await getStatus(); // exhaust via REST (same IP)

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    const listed = await client.listTools(); // unmetered — still works
    expect(listed.tools).toHaveLength(3);

    const res = (await client.callTool({
      name: 'check_korean_business_status',
      arguments: { business_number: A },
    })) as { isError?: boolean; content: { type: string; text: string }[] };

    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body.error).toBe('free_tier_exceeded');
    expect(body.message).toContain('/v1/business/');
    expect(body.message).toContain('x402');
    expect(state.statusCalls).toHaveLength(10); // the blocked call never reached NTS
    await client.close();
  });

  it('MCP tool calls consume the shared counter too', async () => {
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    for (let i = 0; i < 10; i++) {
      const r = (await client.callTool({
        name: 'check_korean_business_status',
        arguments: { business_number: A },
      })) as { isError?: boolean };
      expect(r.isError).toBeFalsy();
    }
    await client.close();

    expect((await getStatus()).status).toBe(402); // REST sees the MCP usage
  });
});

describe('payments disabled (no x402 options)', () => {
  it('never meters — pilot behavior is unchanged', async () => {
    const nts: NtsClient = {
      async checkStatus(bNos) {
        return bNos.map((b) => ({ b_no: b, b_stt_cd: '01', tax_type_cd: '01' }));
      },
      async validate() {
        return [];
      },
    };
    const app = buildApp({ nts, cache: createCache() });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (let i = 0; i < 15; i++) {
        expect((await fetch(`${baseUrl}/v1/business/${A}/status`)).status).toBe(200);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
