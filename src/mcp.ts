/**
 * MCP server factory: defines the two Phase 1 tools and the shared
 * upstream-first / cache-fallback orchestration.
 *
 * A fresh McpServer is built per HTTP request (stateless transport), while
 * `nts` and `cache` are process-wide singletons passed in as deps.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { statusKey, verifyKey, type KbvCache } from './cache.js';
import {
  buildStatusResult,
  InvalidInputError,
  normalizeBusinessNumber,
  SOURCE,
  toNtsDate,
  type StatusResult,
  type VerifyResult,
} from './normalize.js';
import { NtsError, type NtsClient, type NtsStatusItem } from './nts.js';

export type ToolOutcome = 'ok' | 'cache_fallback' | 'invalid_input' | 'upstream_unavailable' | 'internal_error';

export interface Deps {
  nts: NtsClient;
  cache: KbvCache;
  /** Metrics only — implementations must not receive or log query contents. */
  log?: (info: { tool: string; outcome: ToolOutcome; ms: number }) => void;
}

const statusOutputShape = {
  business_number: z.string(),
  status: z.enum(['active', 'suspended', 'closed', 'not_registered']),
  status_code_raw: z.string(),
  tax_type: z.enum(['general', 'simplified', 'exempt', 'non_profit', 'unknown']),
  closed_date: z.string().nullable(),
  checked_at: z.string(),
  source: z.literal(SOURCE),
  cache: z.boolean(),
};

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function okResult(result: StatusResult | VerifyResult): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
}

function errorResult(error: string, message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error, message }, null, 2) }],
  };
}

const UPSTREAM_UNAVAILABLE_MESSAGE =
  'The Korea NTS upstream API is currently unavailable and no cached result exists for this query. Please retry later.';

export function buildMcpServer(deps: Deps): McpServer {
  const server = new McpServer({ name: 'korea-business-verify', version: '0.1.0' });

  /**
   * Shared flow: run `fetchFresh` against the upstream; on success cache the
   * result; on NtsError fall back to the cache entry under `cacheKey`.
   */
  async function run(
    tool: string,
    cacheKey: string,
    fetchFresh: () => Promise<StatusResult | VerifyResult>,
    onSuccess?: (result: StatusResult | VerifyResult) => void,
  ): Promise<ToolResult> {
    const started = Date.now();
    const done = (outcome: ToolOutcome, result: ToolResult): ToolResult => {
      deps.log?.({ tool, outcome, ms: Date.now() - started });
      return result;
    };
    try {
      const result = await fetchFresh();
      deps.cache.set(cacheKey, { result, fetchedAt: result.checked_at });
      onSuccess?.(result);
      return done('ok', okResult(result));
    } catch (err) {
      if (err instanceof InvalidInputError) {
        return done('invalid_input', errorResult('invalid_business_number', err.message));
      }
      if (err instanceof NtsError) {
        const entry = deps.cache.get(cacheKey);
        if (entry) {
          const stale = { ...entry.result, cache: true, checked_at: entry.fetchedAt };
          return done('cache_fallback', okResult(stale));
        }
        return done('upstream_unavailable', errorResult('upstream_unavailable', UPSTREAM_UNAVAILABLE_MESSAGE));
      }
      return done('internal_error', errorResult('internal_error', 'Unexpected server error.'));
    }
  }

  server.registerTool(
    'check_korean_business_status',
    {
      title: 'Check Korean business status',
      description:
        'Check the registration status of a Korean business by its 10-digit business registration number ' +
        '(사업자등록번호). Returns whether the business is active, suspended, or closed, plus tax type. ' +
        'Data source: Korea National Tax Service, real-time.',
      inputSchema: {
        business_number: z
          .string()
          .describe('10-digit Korean business registration number; hyphens/spaces allowed, e.g. "123-45-67890"'),
      },
      outputSchema: statusOutputShape,
    },
    async ({ business_number }) => {
      let bNo: string;
      try {
        bNo = normalizeBusinessNumber(business_number);
      } catch (err) {
        return errorResult('invalid_business_number', (err as Error).message);
      }
      return run('check_korean_business_status', statusKey(bNo), async () => {
        const items = await deps.nts.checkStatus([bNo]);
        const item: NtsStatusItem = items.find((i) => i.b_no === bNo) ?? items[0] ?? { b_no: bNo };
        return buildStatusResult(bNo, item, { cache: false, checkedAt: new Date().toISOString() });
      });
    },
  );

  server.registerTool(
    'verify_korean_business',
    {
      title: 'Verify Korean business identity',
      description:
        'Verify that a Korean business registration number matches the provided representative name and ' +
        'opening date. Use for KYB / due-diligence before transacting with a Korean company. ' +
        'Returns match result plus current status.',
      inputSchema: {
        business_number: z
          .string()
          .describe('10-digit Korean business registration number; hyphens/spaces allowed'),
        representative_name: z.string().min(1).describe('Representative (CEO) name as registered, e.g. "홍길동"'),
        opening_date: z.string().describe('Business opening date in YYYY-MM-DD format, e.g. "2015-03-02"'),
        address: z
          .string()
          .optional()
          .describe('Optional business address to include in the match (maps to NTS b_adr)'),
      },
      outputSchema: { ...statusOutputShape, identity_match: z.boolean() },
    },
    async ({ business_number, representative_name, opening_date, address }) => {
      let bNo: string;
      let startDt: string;
      try {
        bNo = normalizeBusinessNumber(business_number);
        startDt = toNtsDate(opening_date);
      } catch (err) {
        return errorResult('invalid_business_number', (err as Error).message);
      }
      const params = { p_nm: representative_name, start_dt: startDt, b_adr: address };
      return run(
        'verify_korean_business',
        verifyKey(bNo, params),
        async () => {
          const [validateItems, statusItems] = await Promise.all([
            deps.nts.validate([{ b_no: bNo, start_dt: startDt, p_nm: representative_name, ...(address ? { b_adr: address } : {}) }]),
            deps.nts.checkStatus([bNo]),
          ]);
          const statusItem: NtsStatusItem =
            statusItems.find((i) => i.b_no === bNo) ?? statusItems[0] ?? { b_no: bNo };
          const base = buildStatusResult(bNo, statusItem, { cache: false, checkedAt: new Date().toISOString() });
          const result: VerifyResult = { ...base, identity_match: validateItems[0]?.valid === '01' };
          return result;
        },
        // A successful verify also warms the status tool's fallback cache.
        (result) => {
          const { identity_match: _ignored, ...statusOnly } = result as VerifyResult;
          deps.cache.set(statusKey(bNo), { result: statusOnly, fetchedAt: result.checked_at });
        },
      );
    },
  );

  return server;
}
