/**
 * HS code validation for the import-requirements route, mounted BEFORE the
 * x402 payment middleware.
 *
 * Order is the whole point: an unknown code must be refused before the
 * upstream is called (which would answer it with an indistinguishable "no
 * requirements") and before a payment is requested — a caller is never
 * charged for a typo. A 6-digit subheading gets its 10-digit candidates back,
 * also free, and the caller picks one; the server does not guess.
 *
 * The validated lookup is passed on in res.locals.hs for the route handler.
 */

import type { RequestHandler } from 'express';
import type { HsMaster } from './hs-master.js';

export const IMPORT_REQUIREMENTS_PATH = '/v1/korea-import/requirements';

export type HsCheckOutcome = 'ok' | 'invalid_input' | 'hs_code_not_found' | 'hs_code_incomplete' | 'hs_master_unavailable';

export interface HsGuardOptions {
  loadMaster: () => Promise<HsMaster>;
  /** ISO date; injectable so tests can cross an edition boundary. */
  today?: () => string;
  /** Metrics only — never the code itself (codes travel in the URL; see the privacy notes). */
  log?: (info: { outcome: HsCheckOutcome; stale_master?: boolean }) => void;
}

export function hsGuard(opts: HsGuardOptions): RequestHandler {
  const today = opts.today ?? (() => new Date().toISOString().slice(0, 10));
  return async (req, res, next) => {
    if (req.method !== 'GET' || req.path !== IMPORT_REQUIREMENTS_PATH) {
      next();
      return;
    }
    let master: HsMaster;
    try {
      master = await opts.loadMaster();
    } catch {
      // Fail closed: without the master an unknown code could slip through
      // and read as "no requirements". No charge either way.
      opts.log?.({ outcome: 'hs_master_unavailable' });
      res.status(503).json({
        error: 'hs_master_unavailable',
        message: 'The HS code table could not be loaded, so the code cannot be validated. Retry shortly.',
      });
      return;
    }
    const date = today();
    const stale = master.isStale(date) || undefined;
    const result = master.lookup(req.query.hs_code, date);
    switch (result.kind) {
      case 'valid':
        opts.log?.({ outcome: 'ok', stale_master: stale });
        res.locals.hs = result;
        next();
        return;
      case 'invalid_input':
        opts.log?.({ outcome: 'invalid_input', stale_master: stale });
        res.status(400).json({ error: 'invalid_input', message: `Query parameter "hs_code": ${result.message}` });
        return;
      case 'not_found':
        opts.log?.({ outcome: 'hs_code_not_found', stale_master: stale });
        res.status(400).json({
          error: 'hs_code_not_found',
          hs_code: result.hs_code,
          message:
            'Not a current 10-digit Korean HS (HSK) code. Send the full 10-digit code, or 6 digits to list ' +
            'the 10-digit codes under that subheading. Nothing was looked up and nothing was charged.',
        });
        return;
      case 'candidates':
        opts.log?.({ outcome: 'hs_code_incomplete', stale_master: stale });
        res.status(400).json({
          error: 'hs_code_incomplete',
          prefix: result.prefix,
          message:
            `${result.candidates.length} Korean 10-digit codes fall under ${result.prefix}; requirements differ ` +
            'between them. Choose the one that matches the product and ask again. Nothing was charged.',
          candidates: result.candidates,
        });
        return;
    }
  };
}
