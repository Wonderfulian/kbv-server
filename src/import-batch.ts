/**
 * Catalog screening: import/export requirements for up to 100 HS codes in one
 * call (TRADE-DESK §3.3, stage 6).
 *
 * Three rules, each from an earlier mistake or a reading pattern:
 *   - Invalid codes are sorted out BEFORE payment and never billed. They are
 *     reported in summary.invalid_hs. (10/1: the business batch exempted the
 *     test number from the free tier but still settled it — billing and the
 *     quota must come from one count, and here it is `billable`.)
 *   - Codes with requirements come first, then codes whose lookup failed (an
 *     unknown is not a clear), then clear codes: an agent that reads only the
 *     top of the list still sees what will be stopped at customs.
 *   - Only lookups that actually completed are charged. A code whose upstream
 *     call failed is returned unchecked and costs nothing.
 *
 * Fields that would repeat on every item (notice, attribution, disclaimer)
 * are stated once at the top level.
 */

import type { Direction } from './customs.js';
import type { HsCandidate, HsMaster } from './hs-master.js';
import { importRequirements, TEST_HS_CODE, type TradeDeps, type ValidHs } from './import-requirements.js';

export const IMPORT_BATCH_PATH = '/v1/korea-import/requirements/batch';
export const MAX_HS_BATCH = 100;
/** Concurrent upstream calls per batch — the customs API is shared and rate limited. */
const CONCURRENCY = 5;

export interface InvalidHs {
  /** Position in the submitted hs_codes array. */
  index: number;
  input: string;
  error: 'invalid_input' | 'hs_code_not_found' | 'hs_code_incomplete';
  message: string;
  /** For a 6-digit subheading: the 10-digit codes to choose from. */
  candidates?: HsCandidate[];
}

export interface ClassifiedBatch {
  valid: ValidHs[];
  invalid: InvalidHs[];
  /** Valid codes submitted more than once, looked up (and billed) once. */
  duplicates: number;
  /** Valid codes that will be charged: everything except the free test code. */
  billable: number;
}

export function classifyHsCodes(master: HsMaster, inputs: string[], today: string): ClassifiedBatch {
  const valid: ValidHs[] = [];
  const invalid: InvalidHs[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  inputs.forEach((input, index) => {
    const r = master.lookup(input, today);
    switch (r.kind) {
      case 'valid':
        if (seen.has(r.hs_code)) {
          duplicates++;
          return;
        }
        seen.add(r.hs_code);
        valid.push({ hs_code: r.hs_code, name_ko: r.name_ko, name_en: r.name_en });
        return;
      case 'invalid_input':
        invalid.push({ index, input, error: 'invalid_input', message: r.message });
        return;
      case 'not_found':
        invalid.push({ index, input, error: 'hs_code_not_found', message: 'Not a current 10-digit Korean HS (HSK) code.' });
        return;
      case 'candidates':
        invalid.push({
          index,
          input,
          error: 'hs_code_incomplete',
          message: `${r.candidates.length} Korean 10-digit codes fall under ${r.prefix}; requirements differ between them. Choose one.`,
          candidates: r.candidates,
        });
        return;
    }
  });
  return { valid, invalid, duplicates, billable: valid.filter((h) => h.hs_code !== TEST_HS_CODE).length };
}

/** Moved from each item to the top level of the batch response. */
const SHARED = ['governing_notice', 'names_note', 'attribution', 'disclaimer', 'source'] as const;

export async function importRequirementsBatch(
  deps: TradeDeps,
  batch: ClassifiedBatch,
  direction: Direction,
  opts: { full: boolean },
): Promise<{ status: 200 | 503; body: Record<string, unknown>; charged: number }> {
  const items: { hs: ValidHs; status: 200 | 503; body: Record<string, unknown> }[] = new Array(batch.valid.length);
  let next = 0;
  const worker = async () => {
    while (next < batch.valid.length) {
      const i = next++;
      const hs = batch.valid[i];
      const out = await importRequirements(deps, hs, direction, { full: opts.full || hs.hs_code === TEST_HS_CODE });
      items[i] = { hs, ...out };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.valid.length) }, worker));

  const shared: Record<string, unknown> = {};
  const rank = (b: Record<string, unknown>) => (b.has_requirements === true ? 0 : b.requirements_checked === false ? 1 : 2);
  const results = items
    .map((it, order) => ({ it, order }))
    .sort((a, b) => rank(a.it.body) - rank(b.it.body) || a.order - b.order)
    .map(({ it }) => {
      const body = { ...it.body };
      for (const k of SHARED) {
        if (k in body) {
          shared[k] ??= body[k];
          delete body[k];
        }
      }
      return body;
    });

  const failed = items.filter((it) => it.status !== 200).length;
  const withReq = items.filter((it) => it.status === 200 && it.body.has_requirements === true).length;
  const charged = items.filter((it) => it.status === 200 && it.hs.hs_code !== TEST_HS_CODE).length;
  const body: Record<string, unknown> = {
    direction,
    ...(opts.full ? {} : { detail: 'summary', detail_note: 'Statutes, agencies, certificates and quoted conditions are in the paid response (x402).' }),
    results,
    summary: {
      total: batch.valid.length + batch.invalid.length + batch.duplicates,
      checked: batch.valid.length - failed,
      with_requirements: withReq,
      clear: batch.valid.length - failed - withReq,
      failed,
      ...(failed ? { failed_note: 'These codes were not checked (upstream unavailable) and were not charged. They are not "clear" — retry them.' } : {}),
      duplicates_merged: batch.duplicates,
      invalid_hs: batch.invalid,
      ...(batch.invalid.length ? { invalid_hs_note: 'Invalid codes were not looked up and not charged.' } : {}),
    },
    ...shared,
  };
  // Every valid code failed upstream: an error, so a paid call is not settled.
  if (batch.valid.length > 0 && failed === batch.valid.length) {
    return { status: 503, body: { error: 'upstream_unavailable', message: 'The Korea Customs Service could not be reached for any code. Nothing was charged; retry shortly.', ...body }, charged: 0 };
  }
  return { status: 200, body, charged };
}
