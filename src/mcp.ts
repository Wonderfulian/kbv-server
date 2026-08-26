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
import { checkStatus, isServiceError, verifyBusiness, type Deps, type ServiceResult } from './service.js';

export type { Deps, ToolOutcome } from './service.js';

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

function toToolResult(res: ServiceResult<StatusResult | VerifyResult>): ToolResult {
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

export function buildMcpServer(deps: Deps): McpServer {
  const server = new McpServer({ name: 'korea-business-verify', version: '0.1.0' });

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
    async ({ business_number }) => toToolResult(await checkStatus(deps, business_number)),
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
    async ({ business_number, representative_name, opening_date, address }) =>
      toToolResult(await verifyBusiness(deps, { business_number, representative_name, opening_date, address })),
  );

  return server;
}
