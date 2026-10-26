/**
 * Calls the SDK rejects before our handler runs (2026-10-26): they used to
 * leave no trace. These tests run against the installed SDK, so an upgrade
 * that moves its internals fails here instead of silently going blind again.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createCache } from '../src/cache.js';
import { buildMcpServer } from '../src/mcp.js';
import type { NtsClient } from '../src/nts.js';
import type { ToolRejection } from '../src/tool-rejections.js';

async function connect() {
  const rejected: ToolRejection[] = [];
  const calls: string[] = [];
  const nts = {
    async checkStatus(b: string[]) {
      return b.map((b_no) => ({ b_no, b_stt_cd: '01', tax_type_cd: '01' }));
    },
    async validate() {
      return [];
    },
  } as unknown as NtsClient;
  const server = buildMcpServer({
    nts,
    cache: createCache(),
    log: (i) => calls.push(i.tool),
    onToolRejected: (r) => rejected.push(r),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 't', version: '1' });
  await Promise.all([server.connect(a), c.connect(b)]);
  return { c, rejected, calls };
}

const SECRET = '9876543210-SENTINEL';

describe('tool calls rejected by the SDK', () => {
  it('records the tool, the field and the failure kind — and the SDK still answers as before', async () => {
    const { c, rejected, calls } = await connect();
    const r = await c.callTool({ name: 'check_korean_business_status', arguments: { business_number: 1248100998 } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/Input validation error/); // the SDK's own answer, unchanged
    expect(calls).toEqual([]); // our handler never ran — the old blind spot
    expect(rejected).toEqual([{ tool: 'check_korean_business_status', stage: 'schema', issues: [{ field: 'business_number', code: 'invalid_type', expected: 'string' }] }]);
  });

  it('reports a missing field and a wrong argument name the same way a first-time user would hit them', async () => {
    const { c, rejected } = await connect();
    await c.callTool({ name: 'verify_korean_business', arguments: { business_number: SECRET, representative: SECRET, opening_date: SECRET } });
    expect(rejected[0].tool).toBe('verify_korean_business');
    expect(rejected[0].issues).toEqual([{ field: 'representative_name', code: 'invalid_type', expected: 'string' }]);
  });

  it('marks array items and unknown tools without echoing anything the caller sent', async () => {
    const { c, rejected } = await connect();
    await c.callTool({ name: 'check_korean_business_batch', arguments: { business_numbers: [SECRET, 42] } });
    await c.callTool({ name: SECRET, arguments: { q: SECRET } });
    expect(rejected[0].issues).toEqual([{ field: 'business_numbers[]', code: 'invalid_type', expected: 'string' }]);
    expect(rejected[1]).toEqual({ tool: 'unknown_tool', stage: 'unknown_tool', issues: [] });
    expect(JSON.stringify(rejected)).not.toContain('SENTINEL');
    expect(JSON.stringify(rejected)).not.toContain('9876543210');
  });

  it('stays quiet for valid calls and for calls our own handler rejects (those are tool_call events)', async () => {
    const { c, rejected, calls } = await connect();
    await c.callTool({ name: 'check_korean_business_status', arguments: { business_number: '124-81-00998' } });
    await c.callTool({ name: 'check_korean_business_status', arguments: { business_number: '12345' } }); // schema-valid, handler says invalid
    expect(rejected).toEqual([]);
    expect(calls).toEqual(['check_korean_business_status', 'check_korean_business_status']);
  });
});
