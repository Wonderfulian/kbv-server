/**
 * Express app assembly, separated from boot (index.ts) so tests can build
 * the full app with injected deps and no environment/network requirements.
 *
 * MCP runs in stateless mode (sessionIdGenerator: undefined): a fresh
 * McpServer + transport per POST /mcp, the SDK-recommended shape for
 * serverless platforms like Cloud Run (min 0 / multi-instance).
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { buildMcpServer } from './mcp.js';
import { buildRestRouter } from './rest.js';
import type { Deps } from './service.js';

export function buildApp(deps: Deps): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // NOTE: not /healthz — Google's frontend intercepts *z paths (healthz, varz)
  // on run.app URLs and returns its own 404 before the request reaches us.
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(buildRestRouter(deps));

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

  return app;
}
