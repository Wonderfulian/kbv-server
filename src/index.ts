/**
 * Boot only: env loading, process-wide singleton deps, listen.
 * App wiring lives in app.ts so tests can inject mock deps.
 */

import { createFacilitatorConfig } from '@coinbase/x402';
import { HTTPFacilitatorClient } from '@x402/core/server';
import dotenv from 'dotenv';
import { buildApp, type X402Options } from './app.js';
import { createCache } from './cache.js';
import { createNtsClient } from './nts.js';
import type { Deps } from './service.js';

dotenv.config({ quiet: true });

const serviceKey = process.env.NTS_SERVICE_KEY;
if (!serviceKey) {
  // Fail fast with a clear hint; never print key material.
  console.error('FATAL: NTS_SERVICE_KEY is not set. Copy .env.example to .env and add your data.go.kr decoding key.');
  process.exit(1);
}

// Process-wide singletons: the cache must outlive per-request MCP servers.
const deps: Deps = {
  cache: createCache(),
  nts: createNtsClient({
    serviceKey,
    onLatency: (endpoint, ms, ok) => console.log(JSON.stringify({ event: 'nts_call', endpoint, ms, ok })),
  }),
  // Metrics only — no business numbers or names ever reach the logs.
  log: (info) => console.log(JSON.stringify({ event: 'tool_call', ...info })),
};

// Payments are OFF unless a receiving address is configured (address only —
// private keys and seed phrases never touch this server).
const payTo = process.env.X402_PAY_TO_ADDRESS;
// CDP keys present -> authenticated Coinbase facilitator (mainnet path); the
// keys are mounted from Secret Manager and are read here only, never logged.
const cdpFacilitator =
  process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET ? createFacilitatorConfig() : undefined;
const x402: X402Options | undefined = payTo
  ? {
      payTo,
      facilitatorUrl: cdpFacilitator?.url ?? process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator',
      network: process.env.X402_NETWORK ?? 'eip155:84532', // Base Sepolia testnet
      dailyFreeTier: Number(process.env.FREE_TIER_DAILY ?? 10),
      facilitatorClient: cdpFacilitator ? new HTTPFacilitatorClient(cdpFacilitator) : undefined,
    }
  : undefined;
console.log(
  JSON.stringify({
    event: 'x402_config',
    enabled: Boolean(x402),
    network: x402?.network ?? null,
    facilitator: x402 ? (cdpFacilitator ? 'cdp' : x402.facilitatorUrl) : null,
  }),
);

export const app = buildApp(deps, x402);

if (!process.env.VITEST) {
  const port = Number(process.env.PORT ?? 8080);
  app.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ event: 'listening', port }));
  });
}
