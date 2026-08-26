/**
 * REST + discovery route tests: the full Express app (buildApp) listening on
 * an ephemeral port, exercised with real fetch, with a fake NtsClient
 * standing in for the NTS API (same pattern as mcp.test.ts).
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createCache } from '../src/cache.js';
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

interface FakeState {
  statusItems: NtsStatusItem[];
  validateItems: NtsValidateResultItem[];
  error: NtsError | null;
  statusCalls: string[][];
  validateCalls: NtsValidateRequestItem[][];
}

let state: FakeState;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  state = {
    statusItems: [ACTIVE_ITEM],
    validateItems: [{ b_no: B_NO, valid: '01' }],
    error: null,
    statusCalls: [],
    validateCalls: [],
  };
  const nts: NtsClient = {
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
  };
  const app = buildApp({ nts, cache: createCache() });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function postVerify(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/business/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VERIFY_BODY = {
  business_number: '123-45-67890',
  representative_name: '홍길동',
  opening_date: '1999-05-01',
};

describe('GET /v1/business/:brno/status', () => {
  it('returns the normalized English schema for an active business', async () => {
    const res = await fetch(`${baseUrl}/v1/business/${B_NO}/status`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      business_number: B_NO,
      status: 'active',
      status_code_raw: '01',
      tax_type: 'general',
      closed_date: null,
      source: 'Korea National Tax Service (NTS)',
      cache: false,
    });
  });

  it('accepts hyphenated numbers in the path', async () => {
    const res = await fetch(`${baseUrl}/v1/business/123-45-67890/status`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { business_number: string }).business_number).toBe(B_NO);
    expect(state.statusCalls[0]).toEqual([B_NO]);
  });

  it('rejects malformed numbers with 400 without calling the upstream', async () => {
    const res = await fetch(`${baseUrl}/v1/business/12345/status`);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_business_number' });
    expect(state.statusCalls).toHaveLength(0);
  });

  it('maps unregistered numbers to not_registered with 200', async () => {
    state.statusItems = [UNREGISTERED_ITEM];

    const res = await fetch(`${baseUrl}/v1/business/${B_NO}/status`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'not_registered', tax_type: 'unknown' });
  });

  it('returns 503 when the upstream fails and the cache is cold', async () => {
    state.error = new NtsError('network', 'down');

    const res = await fetch(`${baseUrl}/v1/business/${B_NO}/status`);

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'upstream_unavailable' });
  });

  it('falls back to the cache with 200 and cache:true when the upstream fails', async () => {
    const fresh = (await (await fetch(`${baseUrl}/v1/business/${B_NO}/status`)).json()) as { checked_at: string };
    state.error = new NtsError('quota', 'NTS daily quota exceeded (HTTP 429)', 429);

    const res = await fetch(`${baseUrl}/v1/business/${B_NO}/status`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'active', cache: true, checked_at: fresh.checked_at });
  });
});

describe('POST /v1/business/verify', () => {
  it('returns identity_match: true plus merged status on an NTS match', async () => {
    const res = await postVerify(VERIFY_BODY);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      business_number: B_NO,
      identity_match: true,
      status: 'active',
      cache: false,
    });
    // The validate call got the normalized number and the NTS date format.
    expect(state.validateCalls[0][0]).toMatchObject({ b_no: B_NO, start_dt: '19990501', p_nm: '홍길동' });
  });

  it('returns identity_match: false on mismatch, with status still populated', async () => {
    state.validateItems = [{ b_no: B_NO, valid: '02', valid_msg: '확인할 수 없습니다.' }];

    const res = await postVerify(VERIFY_BODY);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ identity_match: false, status: 'active' });
  });

  it('rejects a body with missing fields with 400 without calling the upstream', async () => {
    const res = await postVerify({ business_number: B_NO });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
    expect(state.validateCalls).toHaveLength(0);
  });

  it('rejects a malformed opening_date with 400', async () => {
    const res = await postVerify({ ...VERIFY_BODY, opening_date: '1999/05/01' });

    expect(res.status).toBe(400);
    expect(state.validateCalls).toHaveLength(0);
  });

  it('passes the optional address through as b_adr', async () => {
    await postVerify({ ...VERIFY_BODY, address: '서울특별시 강남구 테헤란로 1' });

    expect(state.validateCalls[0][0].b_adr).toBe('서울특별시 강남구 테헤란로 1');
  });
});

describe('app wiring', () => {
  it('keeps /health and the /mcp method guard working through buildApp', async () => {
    const health = await fetch(`${baseUrl}/health`);
    const mcpGet = await fetch(`${baseUrl}/mcp`);

    expect(await health.json()).toEqual({ ok: true });
    expect(mcpGet.status).toBe(405);
  });
});
