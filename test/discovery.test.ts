/**
 * Discovery documents and the free test number.
 *
 * Both exist because of observed behaviour rather than a spec wish: crawlers
 * asked for /.well-known/x402 and /llms.txt daily and got 404s, and a dev.to
 * reader pointed out that wiring up a client burns the ten free calls.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { FacilitatorClient } from '@x402/core/server';
import { buildApp, type X402Options } from '../src/app.js';
import { createCache } from '../src/cache.js';
import { buildX402Manifest, LLMS_TXT } from '../src/discovery.js';
import { isTestBusinessNumber, TEST_BUSINESS_NUMBER } from '../src/normalize.js';
import type { NtsClient, NtsStatusItem } from '../src/nts.js';
import type { Deps } from '../src/service.js';

const fakeFacilitator = {
  async getSupported() {
    // Both schemes: the batch route is "upto", and a resource server whose
    // facilitator cannot satisfy a configured route refuses to start.
    return {
      kinds: [
        { x402Version: 2, scheme: 'exact', network: 'eip155:84532' },
        { x402Version: 2, scheme: 'upto', network: 'eip155:84532' },
      ],
    };
  },
  async verify(): Promise<never> {
    throw new Error('not used');
  },
  async settle(): Promise<never> {
    throw new Error('not used');
  },
} as unknown as FacilitatorClient;

const X402: X402Options = {
  payTo: '0x0000000000000000000000000000000000000001',
  facilitatorUrl: 'http://127.0.0.1:1',
  network: 'eip155:84532',
  dailyFreeTier: 2, // small, so the exemption is visible
  facilitatorClient: fakeFacilitator,
};

const active: NtsStatusItem = { b_no: TEST_BUSINESS_NUMBER, b_stt_cd: '01', tax_type_cd: '01' };

function deps(calls: string[][] = []): Deps {
  const nts: NtsClient = {
    async checkStatus(bNos) {
      calls.push(bNos);
      return bNos.map((b) => ({ ...active, b_no: b }));
    },
    async validate() {
      return [];
    },
  };
  return { nts, cache: createCache() };
}

describe('buildX402Manifest', () => {
  it('advertises every paid route with its price, from the same route table', () => {
    const manifest = buildX402Manifest({
      routes: {
        'GET /v1/business/search': {
          description: 'search',
          accepts: [{ scheme: 'exact', price: '$0.02', network: 'eip155:8453', payTo: '0xabc' }],
        },
        'POST /v1/business/batch': {
          description: 'batch',
          accepts: [{ scheme: 'upto', price: '$2.00', network: 'eip155:8453', payTo: '0xabc' }],
        },
      },
      updated: '2026-10-01T00:00:00Z',
    });

    expect(manifest.x402Version).toBe(2);
    expect(manifest.kind).toBe('resource-server');
    expect(manifest.resources).toHaveLength(2);
    expect(manifest.resources[0]).toMatchObject({
      method: 'GET',
      url: expect.stringContaining('/v1/business/search'),
      accepts: [{ scheme: 'exact', price: '$0.02' }],
    });
    expect(manifest.resources[1].accepts[0]).toMatchObject({ scheme: 'upto', price: '$2.00' });
  });
});

describe('LLMS_TXT', () => {
  it('leads with the differentiator and states the current price', () => {
    expect(LLMS_TXT).toMatch(/do not need the registration number|does not: give it a company name/i);
    expect(LLMS_TXT).toContain('10 free calls per day');
    expect(LLMS_TXT).toContain('find_korean_business');
    expect(LLMS_TXT).not.toMatch(/free during the pilot/i); // the old, retired copy
  });
});

describe('test number exemption', () => {
  it('recognises the number in any punctuation', () => {
    expect(isTestBusinessNumber('124-81-00998')).toBe(true);
    expect(isTestBusinessNumber('1248100998')).toBe(true);
    expect(isTestBusinessNumber('124 81 00998')).toBe(true);
    expect(isTestBusinessNumber('2208162517')).toBe(false);
    expect(isTestBusinessNumber(undefined)).toBe(false);
  });
});

describe('HTTP surface', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())))),
    );
  });

  async function start(d: Deps, x402?: X402Options): Promise<string> {
    const server = buildApp(d, x402).listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('serves /llms.txt as plain text, unmetered', async () => {
    const base = await start(deps(), X402);
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/llms.txt`);
      expect(res.status).toBe(200); // never 402, however often it is fetched
      expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    }
  });

  it('serves /.well-known/x402 as JSON when payments are configured', async () => {
    const base = await start(deps(), X402);
    const res = await fetch(`${base}/.well-known/x402`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const manifest = (await res.json()) as { kind: string; resources: { url: string }[] };
    expect(manifest.kind).toBe('resource-server');
    expect(manifest.resources.length).toBeGreaterThan(0);
  });

  it('never charges for the test number, however many times it is queried', async () => {
    const calls: string[][] = [];
    const base = await start(deps(calls), X402);
    // The free tier is 2, so an unexempted number would 402 on the third call.
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/v1/business/124-81-00998/status`);
      expect(res.status).toBe(200);
    }
    expect(calls).toHaveLength(5); // all five reached the upstream
    // And the allowance is untouched: a real number still gets its free calls.
    expect((await fetch(`${base}/v1/business/2208162517/status?free=1`)).status).toBe(200);
    expect((await fetch(`${base}/v1/business/2208162517/status?free=1`)).status).toBe(200);
    expect((await fetch(`${base}/v1/business/2208162517/status?free=1`)).status).toBe(402);
  });

  it('bills a batch only for its non-test numbers', async () => {
    const base = await start(deps(), X402);
    // Two test numbers plus one real: one billable unit, inside the tier of 2.
    const res = await fetch(`${base}/v1/business/batch?free=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_numbers: [TEST_BUSINESS_NUMBER, '124-81-00998', '2208162517'] }),
    });
    expect(res.status).toBe(200);
  });
});
