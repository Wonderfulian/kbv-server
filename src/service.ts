/**
 * Transport-agnostic core flows shared by the MCP tools (mcp.ts) and the
 * REST routes (rest.ts): validate input → call NTS → cache on success →
 * cache-fallback on upstream failure.
 *
 * Both channels get identical semantics because they call the same two
 * functions; only the response envelope (MCP tool result vs HTTP status)
 * differs per channel.
 */

import { statusKey, verifyKey, type KbvCache } from './cache.js';
import {
  buildStatusResult,
  InvalidInputError,
  normalizeBusinessNumber,
  toNtsDate,
  type StatusResult,
  type VerifyResult,
} from './normalize.js';
import { NtsError, type NtsClient, type NtsStatusItem } from './nts.js';

export type ToolOutcome = 'ok' | 'cache_fallback' | 'invalid_input' | 'upstream_unavailable' | 'internal_error';

export interface Deps {
  nts: NtsClient;
  cache: KbvCache;
  /** Metrics only — implementations must not receive or log query contents. */
  log?: (info: { tool: string; outcome: ToolOutcome; ms: number }) => void;
}

export interface ServiceError {
  outcome: 'invalid_input' | 'upstream_unavailable' | 'internal_error';
  error: string;
  message: string;
}

export type ServiceResult<T> = { outcome: 'ok' | 'cache_fallback'; result: T } | ServiceError;

export function isServiceError<T>(res: ServiceResult<T>): res is ServiceError {
  return res.outcome !== 'ok' && res.outcome !== 'cache_fallback';
}

export const UPSTREAM_UNAVAILABLE_MESSAGE =
  'The Korea NTS upstream API is currently unavailable and no cached result exists for this query. Please retry later.';

export interface VerifyInput {
  business_number: string;
  representative_name: string;
  opening_date: string;
  address?: string | undefined;
}

/**
 * Shared flow: validate via `prepare` (throws InvalidInputError), fetch fresh
 * from the upstream, cache on success, fall back to the cache on NtsError.
 */
async function run<T extends StatusResult | VerifyResult>(
  deps: Deps,
  tool: string,
  prepare: () => {
    cacheKey: string;
    fetchFresh: () => Promise<T>;
    onSuccess?: (result: T) => void;
  },
): Promise<ServiceResult<T>> {
  const started = Date.now();
  const done = (outcome: ToolOutcome, value: ServiceResult<T>): ServiceResult<T> => {
    deps.log?.({ tool, outcome, ms: Date.now() - started });
    return value;
  };
  let plan: ReturnType<typeof prepare>;
  try {
    plan = prepare();
  } catch (err) {
    if (err instanceof InvalidInputError) {
      return done('invalid_input', { outcome: 'invalid_input', error: 'invalid_business_number', message: err.message });
    }
    return done('internal_error', { outcome: 'internal_error', error: 'internal_error', message: 'Unexpected server error.' });
  }
  try {
    const result = await plan.fetchFresh();
    deps.cache.set(plan.cacheKey, { result, fetchedAt: result.checked_at });
    plan.onSuccess?.(result);
    return done('ok', { outcome: 'ok', result });
  } catch (err) {
    if (err instanceof NtsError) {
      const entry = deps.cache.get(plan.cacheKey);
      if (entry) {
        const stale = { ...(entry.result as T), cache: true, checked_at: entry.fetchedAt };
        return done('cache_fallback', { outcome: 'cache_fallback', result: stale });
      }
      return done('upstream_unavailable', {
        outcome: 'upstream_unavailable',
        error: 'upstream_unavailable',
        message: UPSTREAM_UNAVAILABLE_MESSAGE,
      });
    }
    return done('internal_error', { outcome: 'internal_error', error: 'internal_error', message: 'Unexpected server error.' });
  }
}

export async function checkStatus(
  deps: Deps,
  rawBusinessNumber: string,
  logAs = 'check_korean_business_status',
): Promise<ServiceResult<StatusResult>> {
  return run(deps, logAs, () => {
    const bNo = normalizeBusinessNumber(rawBusinessNumber);
    return {
      cacheKey: statusKey(bNo),
      fetchFresh: async () => {
        const items = await deps.nts.checkStatus([bNo]);
        const item: NtsStatusItem = items.find((i) => i.b_no === bNo) ?? items[0] ?? { b_no: bNo };
        return buildStatusResult(bNo, item, { cache: false, checkedAt: new Date().toISOString() });
      },
    };
  });
}

export async function verifyBusiness(
  deps: Deps,
  input: VerifyInput,
  logAs = 'verify_korean_business',
): Promise<ServiceResult<VerifyResult>> {
  return run(deps, logAs, () => {
    const bNo = normalizeBusinessNumber(input.business_number);
    const startDt = toNtsDate(input.opening_date);
    const address = input.address;
    return {
      cacheKey: verifyKey(bNo, { p_nm: input.representative_name, start_dt: startDt, b_adr: address }),
      fetchFresh: async () => {
        const [validateItems, statusItems] = await Promise.all([
          deps.nts.validate([
            { b_no: bNo, start_dt: startDt, p_nm: input.representative_name, ...(address ? { b_adr: address } : {}) },
          ]),
          deps.nts.checkStatus([bNo]),
        ]);
        const statusItem: NtsStatusItem = statusItems.find((i) => i.b_no === bNo) ?? statusItems[0] ?? { b_no: bNo };
        const base = buildStatusResult(bNo, statusItem, { cache: false, checkedAt: new Date().toISOString() });
        return { ...base, identity_match: validateItems[0]?.valid === '01' };
      },
      // A successful verify also warms the status flow's fallback cache.
      onSuccess: (result) => {
        const { identity_match: _ignored, ...statusOnly } = result;
        deps.cache.set(statusKey(bNo), { result: statusOnly, fetchedAt: result.checked_at });
      },
    };
  });
}
