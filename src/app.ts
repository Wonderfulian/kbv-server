/**
 * Express app assembly, separated from boot (index.ts) so tests can build
 * the full app with injected deps and no environment/network requirements.
 *
 * Payments (PHASE2 stage 2): when `x402` options are given, unpaid REST
 * requests answer 402 by default; `?free=1` opts into an IP-based free tier
 * (units mirror pricing; the counter is shared with MCP so neither channel
 * bypasses the other). Without the options the app behaves exactly like the
 * free pilot.
 *
 * MCP runs in stateless mode (sessionIdGenerator: undefined): a fresh
 * McpServer + transport per POST /mcp, the SDK-recommended shape for
 * serverless platforms like Cloud Run (min 0 / multi-instance).
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { UptoEvmScheme } from '@x402/evm/upto/server';
import { paymentMiddleware, x402ResourceServer, type Network } from '@x402/express';
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
  declareEip2612GasSponsoringExtension,
} from '@x402/extensions';
import express from 'express';
import { buildMcpServer } from './mcp.js';
import { createQuota, type Quota } from './quota.js';
import { buildRestRouter, PRICE_PER_LOOKUP_ATOMIC } from './rest.js';
import type { Deps } from './service.js';

export const MAX_BATCH_PRICE_ATOMIC = 100 * PRICE_PER_LOOKUP_ATOMIC; // $2.00 ceiling for "upto"

export interface X402Options {
  /** Receiving EVM address (0x…). Address only — never key material. */
  payTo: string;
  /** e.g. https://x402.org/facilitator (Base Sepolia, keyless). */
  facilitatorUrl: string;
  /** CAIP-2 id: eip155:84532 = Base Sepolia, eip155:8453 = Base mainnet. */
  network: string;
  /** Free lookups per client IP per UTC day (shared REST + MCP). */
  dailyFreeTier: number;
  /** Injection point for tests / custom facilitators; defaults to HTTP(facilitatorUrl). */
  facilitatorClient?: FacilitatorClient;
}

const STATUS_PATH = /^\/v1\/business\/[^/]+\/status$/;

/**
 * Bazaar catalog metadata. The service name is shared; tags and descriptions
 * are per route on purpose: with one shared vocabulary the catalog's semantic
 * search ranked the status route first for every query (even batch ones) and
 * returned nothing for intent queries that never say "korea" — so each route
 * now carries its own intent words plus generic KYB/screening terms.
 * Spec limits: serviceName <= 32 ASCII chars, at most 5 tags (extras dropped).
 */
const BAZAAR_SERVICE_NAME = 'Korea Business Verify (KBV)';

const BAZAAR_STATUS = {
  serviceName: BAZAAR_SERVICE_NAME,
  tags: ['company-status', 'business-lookup', 'compliance', 'kyb', 'korea'],
};

const BAZAAR_VERIFY = {
  serviceName: BAZAAR_SERVICE_NAME,
  tags: ['kyb', 'due-diligence', 'identity-verification', 'compliance', 'korea'],
};

const BAZAAR_BATCH = {
  serviceName: BAZAAR_SERVICE_NAME,
  tags: ['supplier-screening', 'bulk-verification', 'batch-kyb', 'onboarding', 'korea'],
};

const BAZAAR_SEARCH = {
  serviceName: BAZAAR_SERVICE_NAME,
  tags: ['company-search', 'name-lookup', 'entity-resolution', 'kyb', 'korea'],
};

/** Real response shape used in Bazaar discovery examples (Samsung Electronics, live lookup). */
const STATUS_EXAMPLE = {
  business_number: '1248100998',
  status: 'active',
  status_code_raw: '01',
  tax_type: 'general',
  closed_date: null,
  checked_at: '2026-09-03T00:56:04.239Z',
  source: 'Korea National Tax Service (NTS)',
  cache: false,
};

/** Bazaar example for the search route — the paid (evidence-bearing) shape. */
const SEARCH_EXAMPLE = {
  query: 'Samsung Electronics',
  candidates: [
    {
      business_number: '1248100998',
      name: '삼성전자(주)',
      name_en: 'SAMSUNG ELECTRONICS CO,.LTD',
      confidence: 1,
      match: { type: 'exact', field: 'name_en' },
      evidence: { status: 'active', tax_type: 'general', listed: true },
    },
  ],
  note: '4 companies match this name equally well; they are distinct legal entities.',
};

/**
 * Lookup units a request will consume from the free tier; null = unmetered
 * route, 0 = invalid input that the service will reject anyway (free).
 */
function meteredUnits(req: express.Request): number | null {
  // Search is metered like a lookup, but its free tier returns a usable
  // answer (identity + confidence) rather than a 402 — see rest.ts.
  if (req.method === 'GET' && req.path === '/v1/business/search') return 1;
  if (req.method === 'GET' && STATUS_PATH.test(req.path)) return 1;
  if (req.method === 'POST' && req.path === '/v1/business/verify') return 1;
  if (req.method === 'POST' && req.path === '/v1/business/batch') {
    const nums = (req.body as { business_numbers?: unknown } | undefined)?.business_numbers;
    if (!Array.isArray(nums) || nums.length === 0 || nums.length > 100) return 0;
    return nums.length;
  }
  return null;
}

export function buildApp(deps: Deps, x402?: X402Options): express.Express {
  const app = express();
  // Cloud Run: exactly one Google proxy hop, so req.ip resolves to the real
  // client address (spoofed X-Forwarded-For entries beyond it are ignored).
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  // NOTE: not /healthz — Google's frontend intercepts *z paths (healthz, varz)
  // on run.app URLs and returns its own 404 before the request reaches us.
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  let quota: Quota | undefined;
  if (x402) {
    quota = createQuota(x402.dailyFreeTier);
    const network = x402.network as Network;
    const payTo = x402.payTo;
    const routes = {
      'GET /v1/business/:brno/status': {
        accepts: [{ scheme: 'exact', price: '$0.02', network, payTo }],
        description:
          'Check whether a company is still operating: active, suspended or closed registration status ' +
          'plus tax type, looked up by business registration number. Live Korean National Tax Service (NTS) data.',
        mimeType: 'application/json',
        ...BAZAAR_STATUS,
        extensions: {
          ...declareDiscoveryExtension({
            pathParams: { brno: '124-81-00998' },
            pathParamsSchema: {
              properties: {
                brno: {
                  type: 'string',
                  description: '10-digit Korean business registration number; hyphens/spaces allowed',
                },
              },
              required: ['brno'],
            },
            output: { example: STATUS_EXAMPLE },
          }),
        },
      },
      'GET /v1/business/search': {
        accepts: [{ scheme: 'exact', price: '$0.02', network, payTo }],
        description:
          'Find a Korean company by name when you do not know its registration number: ranked candidates ' +
          'with a confidence score plus the evidence that tells similarly named companies apart — ' +
          'registration status, tax type and region. English and Korean names both work.',
        mimeType: 'application/json',
        ...BAZAAR_SEARCH,
        extensions: {
          ...declareDiscoveryExtension({
            input: { q: 'Samsung Electronics' },
            inputSchema: {
              properties: { q: { type: 'string', description: 'Company name, English or Korean' } },
              required: ['q'],
            },
            output: { example: SEARCH_EXAMPLE },
          }),
        },
      },
      'POST /v1/business/verify': {
        accepts: [{ scheme: 'exact', price: '$0.05', network, payTo }],
        description:
          'KYB identity verification for due diligence and compliance: confirm that a business registration ' +
          'number really matches the representative (CEO) name and opening date before onboarding, contracting ' +
          'with or paying a counterparty. Live Korean National Tax Service (NTS) data.',
        mimeType: 'application/json',
        ...BAZAAR_VERIFY,
        extensions: {
          ...declareDiscoveryExtension({
            bodyType: 'json',
            input: {
              business_number: '124-81-00998',
              representative_name: '홍길동',
              opening_date: '2015-03-02',
            },
            inputSchema: {
              properties: {
                business_number: {
                  type: 'string',
                  description: '10-digit Korean business registration number; hyphens/spaces allowed',
                },
                representative_name: { type: 'string', description: 'Representative (CEO) name as registered' },
                opening_date: { type: 'string', description: 'Business opening date, YYYY-MM-DD' },
                address: { type: 'string', description: 'Optional business address to include in the match' },
              },
              required: ['business_number', 'representative_name', 'opening_date'],
            },
            output: { example: { ...STATUS_EXAMPLE, identity_match: false } },
          }),
        },
      },
      'POST /v1/business/batch': {
        // "upto": client authorizes the $2.00 ceiling; the handler settles
        // the actual usage ($0.02 x numbers) via setSettlementOverrides.
        accepts: [{ scheme: 'upto', price: '$2.00', network, payTo }],
        description:
          'Bulk supplier list screening: check up to 100 companies at once, $0.02 per number, with per-number ' +
          'results and a summary. Batch KYB screening for vendor, customer and supplier onboarding lists. ' +
          'Live Korean National Tax Service (NTS) data.',
        mimeType: 'application/json',
        ...BAZAAR_BATCH,
        extensions: {
          ...declareEip2612GasSponsoringExtension(),
          ...declareDiscoveryExtension({
            bodyType: 'json',
            input: { business_numbers: ['124-81-00998', '123-45-67890'] },
            inputSchema: {
              properties: {
                business_numbers: {
                  type: 'array',
                  items: { type: 'string' },
                  minItems: 1,
                  maxItems: 100,
                  description: '1-100 Korean business registration numbers; hyphens/spaces allowed',
                },
              },
              required: ['business_numbers'],
            },
            output: {
              example: {
                results: [
                  STATUS_EXAMPLE,
                  { ...STATUS_EXAMPLE, business_number: '1234567890', status: 'not_registered', status_code_raw: '' },
                ],
                summary: { total: 2, active: 1, suspended: 0, closed: 0, not_registered: 1 },
              },
            },
          }),
        },
      },
    };
    const facilitatorClient = x402.facilitatorClient ?? new HTTPFacilitatorClient({ url: x402.facilitatorUrl });
    const resourceServer = new x402ResourceServer(facilitatorClient)
      .register(network, new ExactEvmScheme())
      .register(network, new UptoEvmScheme())
      // Bazaar discovery: enriches the route declarations above so the CDP
      // facilitator can index the endpoints (docs.cdp.coinbase.com/x402/seller/get-discovered)
      .registerExtension(bazaarResourceServerExtension);
    const paid = paymentMiddleware(routes, resourceServer);

    app.use((req, res, next) => {
      const units = meteredUnits(req);
      if (units === null || units === 0) {
        next();
        return;
      }
      // The REST free tier is opt-in (?free=1): the default unpaid response
      // must be 402, or the Bazaar validator's required "returns_402" check
      // fails and the routes stay undiscoverable (and anyone could scrape the
      // data free by rotating IPs). MCP keeps using the shared counter
      // automatically — see the quota gate in mcp.ts.
      if (req.query.free === '1' && quota?.tryConsume(req.ip ?? 'unknown', units)) {
        next();
        return;
      }
      res.locals.paid = true; // batch handler settles partial usage on this flag
      void paid(req, res, next);
    });
  }

  app.use(buildRestRouter(deps));

  app.post('/mcp', async (req, res) => {
    try {
      // Same per-IP counter as REST — MCP cannot bypass the paid endpoints.
      const activeQuota = quota;
      const server = buildMcpServer(
        deps,
        activeQuota ? { tryConsume: (units) => activeQuota.tryConsume(req.ip ?? 'unknown', units) } : undefined,
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  // Stateless mode has no sessions to resume or delete.
  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}
