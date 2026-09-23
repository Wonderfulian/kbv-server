/**
 * Phase 1.5 REST routes (DESIGN.md §4) — plain-HTTP mirror of the two MCP
 * tools, sharing the exact same service-layer semantics:
 *
 *   GET  /v1/business/:brno/status
 *   POST /v1/business/verify
 *   POST /v1/business/batch
 *
 * HTTP mapping: ok / cache_fallback → 200 (`cache` field tells them apart),
 * invalid input → 400, upstream down with cold cache → 503, unexpected → 500.
 * Error bodies use the same `{ error, message }` shape as the MCP tools.
 */

import { setSettlementOverrides } from '@x402/express';
import { Router, type Response } from 'express';
import { z } from 'zod';
import {
  checkStatus,
  checkStatusBatch,
  isServiceError,
  verifyBusiness,
  type BatchResult,
  type Deps,
  type ServiceResult,
} from './service.js';
import type { StatusResult, VerifyResult } from './normalize.js';

const HTTP_STATUS: Record<string, number> = {
  invalid_input: 400,
  upstream_unavailable: 503,
  internal_error: 500,
};

/** $0.02 per looked-up number, in USDC atomic units (6 decimals). */
export const PRICE_PER_LOOKUP_ATOMIC = 20_000;

function send(res: Response, out: ServiceResult<StatusResult | VerifyResult | BatchResult>): void {
  if (isServiceError(out)) {
    res.status(HTTP_STATUS[out.outcome] ?? 500).json({ error: out.error, message: out.message });
    return;
  }
  res.status(200).json(out.result);
}

const verifyBodySchema = z.object({
  business_number: z.string(),
  representative_name: z.string().min(1),
  opening_date: z.string(),
  address: z.string().optional(),
});

const batchBodySchema = z.object({
  business_numbers: z.array(z.string()),
});

export function buildRestRouter(deps: Deps): Router {
  const router = Router();

  router.get('/v1/business/:brno/status', async (req, res) => {
    send(res, await checkStatus(deps, req.params.brno, 'rest_status'));
  });

  router.post('/v1/business/verify', async (req, res) => {
    const parsed = verifyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      // Zod issue messages describe expected shapes, never echo input values.
      const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
      res.status(400).json({ error: 'invalid_request', message: `Invalid request body — ${detail}` });
      return;
    }
    send(res, await verifyBusiness(deps, parsed.data, 'rest_verify'));
  });

  router.post('/v1/business/batch', async (req, res) => {
    const parsed = batchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
      res.status(400).json({ error: 'invalid_request', message: `Invalid request body — ${detail}` });
      return;
    }
    const out = await checkStatusBatch(deps, parsed.data.business_numbers, 'rest_batch');
    if (res.locals.paid === true) {
      // "upto" scheme: the client authorized the batch maximum; settle only
      // the actual usage — $0.02 per number, or nothing if the call failed.
      const total = isServiceError(out) ? 0 : out.result.summary.total;
      setSettlementOverrides(res, { amount: String(total * PRICE_PER_LOOKUP_ATOMIC) });
    }
    send(res, out);
  });

  // Name search. Two tiers on one route: the free tier (?free=1) answers with
  // identity and confidence so an agent that knows only a name can still get
  // to a number, while a paid call adds the evidence that tells similarly
  // named companies apart. res.locals.paid is set by the payment middleware.
  router.get('/v1/business/search', async (req, res) => {
    if (!deps.search) {
      res.status(503).json({ error: 'search_unavailable', message: 'The name index is not configured on this server.' });
      return;
    }
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) {
      res.status(400).json({ error: 'invalid_request', message: 'Query parameter "q" (company name) is required.' });
      return;
    }
    const started = Date.now();
    try {
      const out = await deps.search(query, { full: res.locals.paid === true, limit: 5 });
      // A search with no hits is a valid answer, not a failure — the metric
      // counts calls served, and "no such company" is one of them.
      deps.log?.({ tool: 'rest_search', outcome: 'ok', ms: Date.now() - started });
      res.status(200).json(out);
    } catch {
      deps.log?.({ tool: 'rest_search', outcome: 'upstream_unavailable', ms: Date.now() - started });
      res.status(503).json({ error: 'upstream_unavailable', message: 'The name index could not be read. Retry shortly.' });
    }
  });

  return router;
}
