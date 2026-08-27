/**
 * MCP server factory: defines the two Phase 1 tools as thin adapters over
 * the shared service layer (service.ts), which owns the upstream-first /
 * cache-fallback orchestration used by both MCP and REST.
 *
 * A fresh McpServer is built per HTTP request (stateless transport), while
 * `nts` and `cache` are process-wide singletons passed in as deps.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SOURCE, type StatusResult, type VerifyResult } from './normalize.js';
import {
  checkStatus,
  checkStatusBatch,
  isServiceError,
  verifyBusiness,
  type BatchResult,
  type Deps,
  type ServiceResult,
} from './service.js';

export type { Deps, ToolOutcome } from './service.js';

/**
 * Per-request context. When `tryConsume` is present the free-tier quota is
 * enforced on MCP tool calls too (same per-IP counter as REST), so MCP
 * cannot be used to bypass the paid REST endpoints. Over-quota MCP calls get
 * a plain error pointing to the paid REST API instead of an HTTP 402.
 */
export interface McpRequestContext {
  tryConsume?: (units: number) => boolean;
}

const FREE_TIER_MESSAGE =
  'Daily free tier exceeded for this IP (10 lookups per day, one per business number; resets 00:00 UTC). ' +
  'Paid usage is available via the x402-enabled REST API on this host: ' +
  'GET /v1/business/{number}/status ($0.02), POST /v1/business/verify ($0.05), ' +
  'POST /v1/business/batch ($0.02 per number, up to 100). ' +
  'Payments are agent-payable via the x402 protocol (USDC on Base); see the README at ' +
  'https://github.com/Wonderfulian/kbv-server for details.';

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

function errorResult(error: string, message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error, message }, null, 2) }],
  };
}

function toToolResult(res: ServiceResult<StatusResult | VerifyResult | BatchResult>): ToolResult {
  if (isServiceError(res)) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: res.error, message: res.message }, null, 2) }],
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(res.result, null, 2) }],
    structuredContent: res.result as unknown as Record<string, unknown>,
  };
}

export function buildMcpServer(deps: Deps, ctx?: McpRequestContext): McpServer {
  const server = new McpServer({ name: 'korea-business-verify', version: '0.2.0' });

  /**
   * Returns an error result when the free tier is exhausted, null otherwise.
   * `units` mirrors pricing (status/verify = 1, batch = one per number).
   */
  function quotaGate(tool: string, units: number): ToolResult | null {
    if (units <= 0 || !ctx?.tryConsume || ctx.tryConsume(units)) return null;
    deps.log?.({ tool, outcome: 'free_tier_exceeded', ms: 0 });
    return errorResult('free_tier_exceeded', FREE_TIER_MESSAGE);
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
      const gate = quotaGate('check_korean_business_status', 1);
      if (gate) return gate;
      return toToolResult(await checkStatus(deps, business_number));
    },
  );

  server.registerTool(
    'check_korean_business_batch',
    {
      title: 'Batch check Korean business status',
      description:
        'Check the registration status of up to 100 Korean businesses in a single call by their 10-digit ' +
        'business registration numbers (사업자등록번호). Returns one status entry per input number (order ' +
        'preserved) plus a summary count. Use this instead of repeated single checks when screening supplier ' +
        'or customer lists. Recently checked numbers may be answered from a cache up to 24 hours old ' +
        '(marked "cache": true). Data source: Korea National Tax Service.',
      inputSchema: {
        business_numbers: z
          .array(z.string())
          .min(1)
          .describe('1-100 Korean business registration numbers; hyphens/spaces allowed'),
      },
      outputSchema: {
        results: z.array(z.object(statusOutputShape)),
        summary: z.object({
          total: z.number(),
          active: z.number(),
          suspended: z.number(),
          closed: z.number(),
          not_registered: z.number(),
        }),
      },
    },
    async ({ business_numbers }) => {
      // Invalid sizes consume nothing — the service rejects them before any query.
      const units = business_numbers.length <= 100 ? business_numbers.length : 0;
      const gate = quotaGate('check_korean_business_batch', units);
      if (gate) return gate;
      return toToolResult(await checkStatusBatch(deps, business_numbers));
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
      const gate = quotaGate('verify_korean_business', 1);
      if (gate) return gate;
      return toToolResult(await verifyBusiness(deps, { business_number, representative_name, opening_date, address }));
    },
  );

  return server;
}
