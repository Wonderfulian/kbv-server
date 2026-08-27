/**
 * check_korean_business_batch tests, at both entry points:
 * - MCP tool via the SDK's InMemoryTransport (like mcp.test.ts)
 * - REST POST /v1/business/batch via buildApp on an ephemeral port (like rest.test.ts)
 *
 * Batch-specific rules under test (PHASE2 stage 1):
 * one NTS call for the whole batch, >100 rejected before any network call,
 * per-number cache reuse with cache hits excluded from the NTS request.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createCache } from '../src/cache.js';
import { buildMcpServer, type Deps } from '../src/mcp.js';
import { NtsError, type NtsClient, type NtsStatusItem } from '../src/nts.js';
import type { BatchResult } from '../src/service.js';

const A = '1234567890';
const B = '1112223334';
const C = '5556667778';

function activeItem(bNo: string): NtsStatusItem {
  return { b_no: bNo, b_stt_cd: '01', tax_type_cd: '01' };
}
const UNREGISTERED_B: NtsStatusItem = {
  b_no: B,
  b_stt: '',
  b_stt_cd: '',
  tax_type: '국세청에 등록되지 않은 사업자등록번호입니다.',
};

interface FakeState {
  statusItems: NtsStatusItem[];
  error: NtsError | null;
  statusCalls: string[][];
}

function makeDeps(): { deps: Deps; state: FakeState } {
  const state: FakeState = { statusItems: [activeItem(A)], error: null, statusCalls: [] };
  const nts: NtsClient = {
    async checkStatus(bNos) {
      state.statusCalls.push(bNos);
      if (state.error) throw state.error;
      return state.statusItems;
    },
    async validate() {
      throw new Error('validate must not be called by the batch flow');
    },
  };
  return { deps: { nts, cache: createCache() }, state };
}

describe('check_korean_business_batch (MCP tool)', () => {
  async function connect(deps: Deps): Promise<Client> {
    const server = buildMcpServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  interface ToolCallResult {
    isError?: boolean;
    structuredContent?: BatchResult;
    content: { type: string; text: string }[];
  }

  async function call(client: Client, business_numbers: unknown): Promise<ToolCallResult> {
    return (await client.callTool({
      name: 'check_korean_business_batch',
      arguments: { business_numbers },
    })) as unknown as ToolCallResult;
  }

  it('returns one result per input in order, from a single NTS call, plus a summary', async () => {
    const { deps, state } = makeDeps();
    state.statusItems = [activeItem(A), UNREGISTERED_B];
    const client = await connect(deps);

    const res = await call(client, [A, B]);

    expect(res.isError).toBeFalsy();
    const { results, summary } = res.structuredContent as BatchResult;
    expect(results.map((r) => r.business_number)).toEqual([A, B]);
    expect(results[0]).toMatchObject({ status: 'active', tax_type: 'general', cache: false });
    expect(results[1]).toMatchObject({ status: 'not_registered', tax_type: 'unknown' });
    expect(summary).toEqual({ total: 2, active: 1, suspended: 0, closed: 0, not_registered: 1 });
    expect(state.statusCalls).toEqual([[A, B]]);
  });

  it('normalizes hyphenated input and dedupes for the NTS call while keeping input order', async () => {
    const { deps, state } = makeDeps();
    const client = await connect(deps);

    const res = await call(client, ['123-45-67890', A]);

    const { results, summary } = res.structuredContent as BatchResult;
    expect(state.statusCalls).toEqual([[A]]); // duplicate collapsed upstream
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.business_number)).toEqual([A, A]);
    expect(summary.total).toBe(2);
  });

  it('rejects more than 100 numbers before any network call', async () => {
    const { deps, state } = makeDeps();
    const client = await connect(deps);

    const res = await call(client, Array.from({ length: 101 }, () => A));

    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toMatchObject({ error: 'batch_limit_exceeded' });
    expect(state.statusCalls).toHaveLength(0);
  });

  it('rejects a malformed number, naming its index, without calling the upstream', async () => {
    const { deps, state } = makeDeps();
    const client = await connect(deps);

    const res = await call(client, [A, '12345']);

    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body.error).toBe('invalid_business_number');
    expect(body.message).toContain('business_numbers[1]');
    expect(state.statusCalls).toHaveLength(0);
  });

  it('serves cached numbers with cache:true and only fetches the rest from NTS', async () => {
    const { deps, state } = makeDeps();
    const client = await connect(deps);

    const first = await call(client, [A]); // warms the per-number cache
    state.statusItems = [activeItem(C)];
    const second = await call(client, [A, C]);

    const { results, summary } = second.structuredContent as BatchResult;
    expect(state.statusCalls).toEqual([[A], [C]]); // A excluded from the second request
    expect(results[0]).toMatchObject({ business_number: A, cache: true });
    expect(results[0].checked_at).toBe((first.structuredContent as BatchResult).results[0].checked_at);
    expect(results[1]).toMatchObject({ business_number: C, cache: false });
    expect(summary).toMatchObject({ total: 2, active: 2 });
  });

  it('returns upstream_unavailable when NTS fails and some numbers are uncached', async () => {
    const { deps, state } = makeDeps();
    state.error = new NtsError('network', 'down');
    const client = await connect(deps);

    const res = await call(client, [A]);

    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toMatchObject({ error: 'upstream_unavailable' });
  });

  it('answers entirely from cache (no NTS call) when every number is cached', async () => {
    const { deps, state } = makeDeps();
    const client = await connect(deps);

    await call(client, [A]);
    state.error = new NtsError('quota', 'NTS daily quota exceeded (HTTP 429)', 429);
    const res = await call(client, [A]);

    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as BatchResult).results[0]).toMatchObject({ status: 'active', cache: true });
    expect(state.statusCalls).toEqual([[A]]); // second call never reached NTS
  });
});

describe('POST /v1/business/batch (REST)', () => {
  let state: FakeState;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    const made = makeDeps();
    state = made.state;
    const app = buildApp(made.deps);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  async function post(body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/v1/business/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns results and summary with 200', async () => {
    state.statusItems = [activeItem(A), UNREGISTERED_B];

    const res = await post({ business_numbers: [A, B] });

    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchResult;
    expect(body.results.map((r) => r.business_number)).toEqual([A, B]);
    expect(body.summary).toEqual({ total: 2, active: 1, suspended: 0, closed: 0, not_registered: 1 });
  });

  it('rejects a body without business_numbers with 400 invalid_request', async () => {
    const res = await post({ numbers: [A] });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
    expect(state.statusCalls).toHaveLength(0);
  });

  it('rejects an empty array with 400 without calling the upstream', async () => {
    const res = await post({ business_numbers: [] });

    expect(res.status).toBe(400);
    expect(state.statusCalls).toHaveLength(0);
  });

  it('rejects more than 100 numbers with 400 batch_limit_exceeded', async () => {
    const res = await post({ business_numbers: Array.from({ length: 101 }, () => A) });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'batch_limit_exceeded' });
    expect(state.statusCalls).toHaveLength(0);
  });

  it('returns 503 when NTS is down and the cache is cold', async () => {
    state.error = new NtsError('network', 'down');

    const res = await post({ business_numbers: [A] });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'upstream_unavailable' });
  });
});
