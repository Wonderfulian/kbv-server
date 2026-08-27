/**
 * Express app assembly, separated from boot (index.ts) so tests can build
 * the full app with injected deps and no environment/network requirements.
 *
 * Payments (PHASE2 stage 2): when `x402` options are given, the three REST
 * endpoints get an IP-based free tier (units mirror pricing; the counter is
 * shared with MCP so neither channel bypasses the other) and over-quota
 * requests flow into the x402 payment middleware (HTTP 402). Without the
 * options the app behaves exactly like the free pilot.
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
import { declareEip2612GasSponsoringExtension } from '@x402/extensions';
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
 * Lookup units a request will consume from the free tier; null = unmetered
 * route, 0 = invalid input that the service will reject anyway (free).
 */
function meteredUnits(req: express.Request): number | null {
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
        description: 'Korean business registration status + tax type by business number (NTS, real-time)',
        mimeType: 'application/json',
      },
      'POST /v1/business/verify': {
        accepts: [{ scheme: 'exact', price: '$0.05', network, payTo }],
        description: 'Korean business KYB identity check: number + representative name + opening date',
        mimeType: 'application/json',
      },
      'POST /v1/business/batch': {
        // "upto": client authorizes the $2.00 ceiling; the handler settles
        // the actual usage ($0.02 x numbers) via setSettlementOverrides.
        accepts: [{ scheme: 'upto', price: '$2.00', network, payTo }],
        description: 'Batch Korean business status check, $0.02 per number, up to 100 per call',
        mimeType: 'application/json',
        extensions: { ...declareEip2612GasSponsoringExtension() },
      },
    };
    const facilitatorClient = x402.facilitatorClient ?? new HTTPFacilitatorClient({ url: x402.facilitatorUrl });
    const resourceServer = new x402ResourceServer(facilitatorClient)
      .register(network, new ExactEvmScheme())
      .register(network, new UptoEvmScheme());
    const paid = paymentMiddleware(routes, resourceServer);

    app.use((req, res, next) => {
      const units = meteredUnits(req);
      if (units === null || units === 0) {
        next();
        return;
      }
      if (quota?.tryConsume(req.ip ?? 'unknown', units)) {
        next(); // free tier
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
