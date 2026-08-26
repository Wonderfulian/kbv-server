/**
 * Boot only: env loading, process-wide singleton deps, listen.
 * App wiring lives in app.ts so tests can inject mock deps.
 */

import dotenv from 'dotenv';
import { buildApp } from './app.js';
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

export const app = buildApp(deps);

if (!process.env.VITEST) {
  const port = Number(process.env.PORT ?? 8080);
  app.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ event: 'listening', port }));
  });
}
