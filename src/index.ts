/**
 * Express boot + stateless MCP Streamable HTTP mount.
 *
 * Stateless mode (sessionIdGenerator: undefined) creates a fresh
 * McpServer + transport per POST /mcp, which is the SDK-recommended shape
 * for serverless platforms like Cloud Run (min 0 / multi-instance).
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import dotenv from 'dotenv';
import express from 'express';
import { createCache } from './cache.js';
import { buildMcpServer, type Deps } from './mcp.js';
import { createNtsClient } from './nts.js';

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

export const app = express();
app.use(express.json({ limit: '1mb' }));

// NOTE: not /healthz — Google's frontend intercepts *z paths (healthz, varz)
// on run.app URLs and returns its own 404 before the request reaches us.
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/mcp', async (req, res) => {
  try {
    const server = buildMcpServer(deps);
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

if (!process.env.VITEST) {
  const port = Number(process.env.PORT ?? 8080);
  app.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ event: 'listening', port }));
  });
}
