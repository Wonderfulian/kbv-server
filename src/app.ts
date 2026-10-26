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
import { buildLlmsTxt, buildX402Manifest } from './discovery.js';
import { hsGuard, IMPORT_REQUIREMENTS_PATH } from './hs-guard.js';
import { normalizeHsInput } from './hs-master.js';
import { TEST_HS_CODE } from './import-requirements.js';
import { IMPORT_BATCH_PATH, type ClassifiedBatch } from './import-batch.js';
import { isTestBusinessNumber } from './normalize.js';
import type { Deps } from './service.js';

const IMPORT_ROUTE_KEY = `GET ${IMPORT_REQUIREMENTS_PATH}` as const;
const IMPORT_BATCH_ROUTE_KEY = `POST ${IMPORT_BATCH_PATH}` as const;

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
  /**
   * Lists the import-requirements route as paid. OFF in production until the
   * route has a handler (TRADE-DESK stage 4) — a paid route without one would
   * take money and then 404, and would be advertised in discovery meanwhile.
   */
  tradeDesk?: boolean;
}

/** Capturing group 1 is the raw number, used for the test-number exemption. */
const STATUS_PATH = /^\/v1\/business\/([^/]+)\/status$/;

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
  tags: ['supplier-screening', 'debarment-check', 'sanctions-screening', 'batch-kyb', 'korea'],
};

const BAZAAR_SEARCH = {
  serviceName: BAZAAR_SERVICE_NAME,
  tags: ['find-company-by-name', 'company-search', 'name-to-id', 'entity-resolution', 'korea'],
};

const BAZAAR_IMPORT_BATCH = {
  serviceName: BAZAAR_SERVICE_NAME,
  // At most 5 tags: @x402/extensions keeps the first five and drops the rest silently (MAX_TAGS).
  tags: ['screen-catalog', 'korea-import', 'hs-code', 'bulk-import-check', 'cross-border-ecommerce'],
};

const BAZAAR_IMPORT = {
  serviceName: BAZAAR_SERVICE_NAME,
  tags: ['korea-import', 'customs-clearance', 'kc-certification', 'mfds', 'hs-code'],
};

/** Bazaar example for the import routes — abridged from the live response for the free test code. */
const IMPORT_EXAMPLE = {
  hs_code: '8516710000',
  direction: 'import',
  item_name_en: 'Coffee or tea makers',
  hs_code_valid: true,
  requirements_checked: true,
  has_requirements: true,
  requirement_count: 3,
  requirements: [
    {
      statute_name_en: 'Electrical Appliances and Consumer Products Safety Control Act',
      statute_name_ko: '전기용품 및 생활용품 안전관리법',
      certificate_name_ko: '전기용품 및 생활용품 요건확인서',
      approving_agencies: [
        { code: '105', name_ko: '국가기술표준원', name_en: 'Korean Agency for Technology and Standards' },
        { code: '257', name_ko: '한국화학융합시험연구원', name_en: 'Korea Testing & Research Institute' },
      ],
      agencies_note: 'Any one of the listed agencies may issue this certificate.',
      condition: { text_ko: '[전기용품 및 생활용품 안전관리법] . 정격전압이 30V초과 1000V이하의 교류전원 …', text_en_unofficial: null, granularity: 'hs10' },
    },
  ],
  attribution: 'Source: Ministry of Government Legislation (법제처), law.go.kr',
  source: 'Korea Customs Service (KCS)',
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
function meteredUnits(req: express.Request, res: express.Response, tradeDesk: boolean): number | null {
  // Search is metered like a lookup, but its free tier returns a usable
  // answer (identity + confidence) rather than a 402 — see rest.ts.
  if (req.method === 'GET' && req.path === '/v1/business/search') return 1;
  // Reached only with a validated code: hsGuard answers every other input first.
  // The documented test code is free and unlimited, like the test business number.
  if (req.method === 'GET' && req.path === IMPORT_REQUIREMENTS_PATH) {
    if (!tradeDesk) return null;
    return normalizeHsInput(req.query.hs_code) === TEST_HS_CODE ? null : 1;
  }
  if (req.method === 'POST' && req.path === IMPORT_BATCH_PATH) {
    if (!tradeDesk) return null;
    // hsGuard has classified the codes: invalid ones and the test code are not
    // billable. The same count drives the free tier here and the settlement in
    // the handler — one number, so the two cannot disagree (the 10/1 bug).
    const batch = res.locals.hsBatch as ClassifiedBatch | undefined;
    if (!batch) return 0;
    return batch.billable === 0 ? null : batch.billable;
  }
  if (req.method === 'GET' && STATUS_PATH.test(req.path)) {
    // The documented test number is free and unlimited, so wiring up a client
    // does not cost a developer their ten daily calls.
    return isTestBusinessNumber(STATUS_PATH.exec(req.path)?.[1]) ? null : 1;
  }
  if (req.method === 'POST' && req.path === '/v1/business/verify') {
    // The test number is free here too: connecting a client should not cost
    // the most expensive call. Only money and quota are waived — the identity
    // check itself runs for real and can come back false.
    const num = (req.body as { business_number?: unknown } | undefined)?.business_number;
    return isTestBusinessNumber(typeof num === 'string' ? num : undefined) ? null : 1;
  }
  if (req.method === 'POST' && req.path === '/v1/business/batch') {
    const nums = (req.body as { business_numbers?: unknown } | undefined)?.business_numbers;
    if (!Array.isArray(nums) || nums.length === 0 || nums.length > 100) return 0;
    // Test numbers in a batch are free too; a batch of only test numbers is
    // unmetered rather than charged as zero (which would read as invalid).
    const billable = nums.filter((x) => !isTestBusinessNumber(typeof x === 'string' ? x : undefined)).length;
    return billable === 0 ? null : billable;
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

  // Discovery documents, free and unmetered — crawlers were getting 404s for
  // both. Registered before the payment middleware so they can never end up
  // behind a paywall, which would defeat their purpose.
  // The text is replaced below once the route table exists; the route itself
  // must be registered here, ahead of the payment middleware.
  let llmsTxt = buildLlmsTxt();
  app.get('/llms.txt', (_req, res) => {
    res.type('text/plain; charset=utf-8').set('Cache-Control', 'public, max-age=3600').send(llmsTxt);
  });

  // HS code validation runs before the payment middleware below: an unknown
  // code is refused free of charge and never reaches the upstream, whose
  // answer to it would be indistinguishable from "no requirements".
  if (deps.hsMaster) app.use(hsGuard({ loadMaster: deps.hsMaster, log: deps.hsLog }));

  let quota: Quota | undefined;
  if (x402) {
    quota = createQuota(x402.dailyFreeTier);
    const network = x402.network as Network;
    const payTo = x402.payTo;
    // Bazaar copy (owner's wording, 2026-10-26): the first line names the
    // situation the agent is stuck in, not the feature — what moved
    // a route from #5 to #1 in catalog search was a rewrite of that kind.
    const importRoute = {
      accepts: [{ scheme: 'exact', price: '$0.03', network, payTo }],
      description:
        'Find out what Korea requires before you ship. Give an HS code and get back which statutes gate customs ' +
        'release, which agencies can issue the approval (often several — any one will do), the exact certificate ' +
        'name, and the condition text quoted verbatim from the governing notice. Goods that need an unmet approval ' +
        'are held or returned at the border. Source: Korea Customs Service and the Ministry of Government Legislation.',
      mimeType: 'application/json',
      ...BAZAAR_IMPORT,
      extensions: {
        ...declareDiscoveryExtension({
          input: { hs_code: '8516710000' },
          inputSchema: {
            properties: {
              hs_code: { type: 'string', description: '10-digit Korean HS (HSK) code; dots/hyphens allowed' },
            },
            required: ['hs_code'],
          },
          output: { example: IMPORT_EXAMPLE },
        }),
      },
    };
    const importBatchRoute = {
      // "upto": the client authorizes $2.00; the handler settles $0.02 per
      // valid code actually looked up.
      accepts: [{ scheme: 'upto', price: '$2.00', network, payTo }],
      description:
        'Screen a product catalog for Korean import restrictions in one call. Submit up to 100 HS codes; the ' +
        'restricted ones come back first, each with the statute, the approving agencies, the certificate required ' +
        'and the condition text from the notice. Codes that could not be checked are listed before the clear ones, ' +
        'so "unverified" is never mistaken for "clear".',
      mimeType: 'application/json',
      ...BAZAAR_IMPORT_BATCH,
      extensions: {
        ...declareEip2612GasSponsoringExtension(),
        ...declareDiscoveryExtension({
          bodyType: 'json',
          input: { hs_codes: ['8516710000', '7318152000'] },
          inputSchema: {
            properties: {
              hs_codes: {
                type: 'array',
                items: { type: 'string' },
                minItems: 1,
                maxItems: 100,
                description: '1-100 Korean 10-digit HS (HSK) codes; dots/hyphens allowed',
              },
              direction: { type: 'string', enum: ['import', 'export'], description: 'Default "import"' },
            },
            required: ['hs_codes'],
          },
          output: {
            example: {
              direction: 'import',
              // Kept short: the whole route declaration travels in the 402 header.
              results: [
                { hs_code: '8516710000', item_name_en: 'Coffee or tea makers', has_requirements: true, requirement_count: 3, requirements: ['…'] },
                { hs_code: '7318152000', item_name_en: 'Bolts', has_requirements: false, requirement_count: 0, requirements: [] },
              ],
              summary: {
                total: 3,
                checked: 2,
                with_requirements: 1,
                clear: 1,
                failed: 0,
                duplicates_merged: 0,
                invalid_hs: [{ index: 2, input: '9999999999', error: 'hs_code_not_found', message: 'Not a current 10-digit Korean HS (HSK) code.' }],
              },
            },
          },
        }),
      },
    };
    const baseRoutes = {
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
          'Search for a Korean company by name and get its business registration number. Use this when you ' +
          'only know what a company is called — in English or Korean — and need the 10-digit number that ' +
          'other lookups require. Returns ranked candidates with a confidence score and the evidence that ' +
          'tells similarly named companies apart: registration status, tax type and region.',
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
          'Screen a supplier list against two registries at once: check up to 100 companies per call, $0.02 ' +
          'per number, and get registration status plus any public-procurement debarment on record. A ' +
          'company can be active and still barred from public contracts, so the summary counts how many ' +
          'are currently debarred. Live Korean National Tax Service and Public Procurement Service data.',
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
    // The import-requirements route is listed only behind the stage flag.
    const routes = x402.tradeDesk ? { [IMPORT_ROUTE_KEY]: importRoute, [IMPORT_BATCH_ROUTE_KEY]: importBatchRoute, ...baseRoutes } : baseRoutes;
    // The manifest is generated from this very route table, so a price can
    // never drift between a 402 response and what discovery advertises.
    const manifest = buildX402Manifest({ routes, updated: new Date().toISOString() });
    // Same table, same prices: llms.txt can no longer drift from the 402s.
    const unit = `$${(PRICE_PER_LOOKUP_ATOMIC / 1_000_000).toFixed(2)}`;
    llmsTxt = buildLlmsTxt(routes, { 'POST /v1/business/batch': `${unit} per number`, [IMPORT_BATCH_ROUTE_KEY]: `${unit} per valid HS code` });
    app.get('/.well-known/x402', (_req, res) => {
      res.type('application/json').set('Cache-Control', 'public, max-age=3600').json(manifest);
    });

    const facilitatorClient = x402.facilitatorClient ?? new HTTPFacilitatorClient({ url: x402.facilitatorUrl });
    const resourceServer = new x402ResourceServer(facilitatorClient)
      .register(network, new ExactEvmScheme())
      .register(network, new UptoEvmScheme())
      // Bazaar discovery: enriches the route declarations above so the CDP
      // facilitator can index the endpoints (docs.cdp.coinbase.com/x402/seller/get-discovered)
      .registerExtension(bazaarResourceServerExtension);
    const paid = paymentMiddleware(routes, resourceServer);

    app.use((req, res, next) => {
      const units = meteredUnits(req, res, x402.tradeDesk === true);
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
