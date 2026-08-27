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
    send(res, await checkStatusBatch(deps, parsed.data.business_numbers, 'rest_batch'));
  });

  return router;
}
