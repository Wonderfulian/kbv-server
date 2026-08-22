/**
 * End-to-end tool tests: a real MCP client talks to buildMcpServer over the
 * SDK's InMemoryTransport, with a fake NtsClient standing in for the NTS API.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createCache } from '../src/cache.js';
import { buildMcpServer, type Deps } from '../src/mcp.js';
import {
  NtsError,
  type NtsClient,
  type NtsStatusItem,
  type NtsValidateRequestItem,
  type NtsValidateResultItem,
} from '../src/nts.js';

const B_NO = '1234567890';
const ACTIVE_ITEM: NtsStatusItem = { b_no: B_NO, b_stt_cd: '01', tax_type_cd: '01' };
const UNREGISTERED_ITEM: NtsStatusItem = {
  b_no: B_NO,
  b_stt: '',
  b_stt_cd: '',
  tax_type: '국세청에 등록되지 않은 사업자등록번호입니다.',
};

interface FakeNts {
  nts: NtsClient;
  state: {
    statusItems: NtsStatusItem[];
    validateItems: NtsValidateResultItem[];
    error: NtsError | null;
    statusCalls: string[][];
    validateCalls: NtsValidateRequestItem[][];
  };
}

function makeFakeNts(): FakeNts {
  const state: FakeNts['state'] = {
    statusItems: [ACTIVE_ITEM],
    validateItems: [{ b_no: B_NO, valid: '01' }],
    error: null,
    statusCalls: [],
    validateCalls: [],
  };
  return {
    state,
    nts: {
      async checkStatus(bNos) {
        state.statusCalls.push(bNos);
        if (state.error) throw state.error;
        return state.statusItems;
      },
      async validate(items) {
        state.validateCalls.push(items);
        if (state.error) throw state.error;
        return state.validateItems;
      },
    },
  };
}

async function connect(deps: Deps): Promise<Client> {
  const server = buildMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

interface ToolCallResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: { type: string; text: string }[];
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolCallResult;
}

describe('tools/list', () => {
  it('exposes exactly the two Phase 1 tools with English descriptions', async () => {
    const { nts } = makeFakeNts();
    const client = await connect({ nts, cache: createCache() });

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['check_korean_business_status', 'verify_korean_business']);
    for (const tool of tools) {
      expect(tool.description).toMatch(/Korean business/);
    }
  });
});

describe('check_korean_business_status', () => {
  it('returns the normalized English schema for an active business', async () => {
    const { nts } = makeFakeNts();
    const client = await connect({ nts, cache: createCache() });

    const res = await call(client, 'check_korean_business_status', { business_number: B_NO });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      business_number: B_NO,
      status: 'active',
      status_code_raw: '01',
      tax_type: 'general',
      closed_date: null,
      source: 'Korea National Tax Service (NTS)',
      cache: false,
    });
    expect(typeof res.structuredContent?.checked_at).toBe('string');
  });

  it('normalizes hyphenated input', async () => {
    const { nts, state } = makeFakeNts();
    const client = await connect({ nts, cache: createCache() });

    const res = await call(client, 'check_korean_business_status', { business_number: '123-45-67890' });

    expect(res.structuredContent?.business_number).toBe(B_NO);
    expect(state.statusCalls[0]).toEqual([B_NO]);
  });

  it('rejects malformed numbers without calling the upstream', async () => {
    const { nts, state } = makeFakeNts();
    const client = await connect({ nts, cache: createCache() });

    const res = await call(client, 'check_korean_business_status', { business_number: '12345' });

    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toMatchObject({ error: 'invalid_business_number' });
    expect(state.statusCalls).toHaveLength(0);
  });

  it('maps unregistered numbers to not_registered / unknown', async () => {
    const { nts, state } = makeFakeNts();
    state.statusItems = [UNREGISTERED_ITEM];
    const client = await connect({ nts, cache: createCache() });

    const res = await call(client, 'check_korean_business_status', { business_number: B_NO });

    expect(res.structuredContent).toMatchObject({ status: 'not_registered', tax_type: 'unknown' });
  });

  it('falls back to the cache with cache:true when the upstream fails', async () => {
    const { nts, state } = makeFakeNts();
    const client = await connect({ nts, cache: createCache() });

    const fresh = await call(client, 'check_korean_business_status', { business_number: B_NO });
    state.error = new NtsError('quota', 'NTS daily quota exceeded (HTTP 429)', 429);
    const stale = await call(client, 'check_korean_business_status', { business_number: B_NO });

    expect(stale.isError).toBeFalsy();
    expect(stale.structuredContent).toMatchObject({ status: 'active', cache: true });
    expect(stale.structuredContent?.checked_at).toBe(fresh.structuredContent?.checked_at);
  });

  it('returns upstream_unavailable when the upstream fails and the cache is cold', async () => {
    const { nts, state } = makeFakeNts();
    state.error = new NtsError('network', 'NTS status request failed (network error or timeout)');
    const client = await connect({ nts, cache: createCache() });

    const res = await call(client, 'check_korean_business_status', { business_number: B_NO });

    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toMatchObject({ error: 'upstream_unavailable' });
  });
});

describe('verify_korean_business', () => {
  const ARGS = {
    business_number: '123-45-67890',
    representative_name: '홍길동',
    opening_date: '1999-05-01',
  };

  it('returns identity_match: true plus merged status when NTS confirms a match', async () => {
    const { nts, state } = makeFakeNts();
    const client = await connect({ nts, cache: createCache() });

    const res = await call(client, 'verify_korean_business', ARGS);

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      business_number: B_NO,
      identity_match: true,
      status: 'active',
      tax_type: 'general',
      cache: false,
    });
    // The validate call got the normalized number and the NTS date format.
    expect(state.validateCalls[0][0]).toMatchObject({ b_no: B_NO, start_dt: '19990501', p_nm: '홍길동' });
    expect(state.statusCalls[0]).toEqual([B_NO]);
  });

  it('returns identity_match: false on mismatch, with status still populated', async () => {
    const { nts, state } = makeFakeNts();
    state.validateItems = [{ b_no: B_NO, valid: '02', valid_msg: '확인할 수 없습니다.' }];
    const client = await connect({ nts, cache: createCache() });

    const res = await call(client, 'verify_korean_business', ARGS);

    expect(res.structuredContent).toMatchObject({ identity_match: false, status: 'active' });
  });

  it('passes the optional address through as b_adr', async () => {
    const { nts, state } = makeFakeNts();
    const client = await connect({ nts, cache: createCache() });

    await call(client, 'verify_korean_business', { ...ARGS, address: '서울특별시 강남구 테헤란로 1' });

    expect(state.validateCalls[0][0].b_adr).toBe('서울특별시 강남구 테헤란로 1');
  });

  it('omits b_adr entirely when no address is given', async () => {
    const { nts, state } = makeFakeNts();
    const client = await connect({ nts, cache: createCache() });

    await call(client, 'verify_korean_business', ARGS);

    expect('b_adr' in state.validateCalls[0][0]).toBe(false);
  });

  it('rejects a malformed opening_date without calling the upstream', async () => {
    const { nts, state } = makeFakeNts();
    const client = await connect({ nts, cache: createCache() });

    const res = await call(client, 'verify_korean_business', { ...ARGS, opening_date: '1999/05/01' });

    expect(res.isError).toBe(true);
    expect(state.validateCalls).toHaveLength(0);
    expect(state.statusCalls).toHaveLength(0);
  });

  it('falls back to its own cache when the upstream fails', async () => {
    const { nts, state } = makeFakeNts();
    const cache = createCache();
    const client = await connect({ nts, cache });

    const fresh = await call(client, 'verify_korean_business', ARGS);
    state.error = new NtsError('network', 'down');
    const stale = await call(client, 'verify_korean_business', ARGS);

    expect(stale.structuredContent).toMatchObject({ identity_match: true, cache: true });
    expect(stale.structuredContent?.checked_at).toBe(fresh.structuredContent?.checked_at);
  });

  it('warms the status cache so the status tool survives an outage', async () => {
    const { nts, state } = makeFakeNts();
    const cache = createCache();
    const client = await connect({ nts, cache });

    await call(client, 'verify_korean_business', ARGS);
    state.error = new NtsError('network', 'down');
    const res = await call(client, 'check_korean_business_status', { business_number: B_NO });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ status: 'active', cache: true });
    expect(res.structuredContent).not.toHaveProperty('identity_match');
  });
});
