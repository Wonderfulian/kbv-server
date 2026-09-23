/**
 * Name search: the feature that removes KBV's original entry barrier.
 *
 * Two response tiers, matching the pricing decision "finding is free,
 * confirming is paid":
 *   basic  name, business number, confidence, how it matched
 *   full   + evidence (registration status, tax type, region, listed)
 *
 * The free tier returns `basic`, so an agent that only knows a company name
 * can always get to a number. Evidence — the part that tells four
 * similarly-named companies apart — is what the paid call adds.
 *
 * Numbers are resolved lazily. The index ships with identity for every DART
 * filer but only a slice of their business numbers, because that lookup is
 * rate-limited per company; when a search surfaces a candidate whose number
 * is still missing, we resolve just that one and remember it for the life of
 * the process. The periodic build job persists the rest in the background.
 */

import type { DartClient } from './dart.js';
import type { NtsClient } from './nts.js';
import { buildStatusResult, type BusinessStatus, type TaxType } from './normalize.js';
import { disambiguationNote, searchIndex, type Candidate, type NameIndexEntry } from './name-index.js';

export interface SearchCandidate {
  business_number: string | null;
  name: string;
  name_en?: string;
  confidence: number;
  match: { type: string; field: string };
  /** Present only in the paid tier. */
  evidence?: {
    status?: BusinessStatus;
    tax_type?: TaxType;
    region?: string;
    listed?: boolean;
  };
}

export interface SearchResponse {
  query: string;
  candidates: SearchCandidate[];
  /** Set when several candidates are equally good — agents act on text. */
  note?: string;
  /** Absent in the basic tier; the paid tier states its source. */
  source?: string;
}

export interface SearchDeps {
  /** Loads the index once; the caller decides how to memoize. */
  loadIndex: () => Promise<NameIndexEntry[]>;
  nts: NtsClient;
  /** Optional: without it, candidates missing a number stay unresolved. */
  dart?: DartClient;
  /** Process-lifetime memo of corp_code → business number. */
  resolved?: Map<string, string>;
  now?: () => Date;
}

export interface SearchOptions {
  limit?: number;
  /** Paid tier: attach discriminating evidence. */
  full?: boolean;
}

/** Resolves business numbers for candidates that lack one, bounded to this page. */
async function resolveNumbers(deps: SearchDeps, candidates: Candidate[]): Promise<void> {
  if (!deps.dart) return;
  const memo = deps.resolved;
  await Promise.all(
    candidates.map(async (candidate) => {
      const entry = candidate.entry;
      if (entry.business_number || !entry.corp_code) return;
      const cached = memo?.get(entry.corp_code);
      if (cached) {
        entry.business_number = cached;
        return;
      }
      try {
        const number = await (deps.dart as DartClient).fetchBusinessNumber(entry.corp_code);
        if (number) {
          entry.business_number = number;
          memo?.set(entry.corp_code, number);
        }
      } catch {
        // A rate-limited or failing lookup costs this candidate its number,
        // not the whole search — the name and confidence still stand.
      }
    }),
  );
}

/** Looks up live status for the candidates that have a number (one batch). */
async function fetchEvidence(
  deps: SearchDeps,
  candidates: Candidate[],
): Promise<Map<string, { status: BusinessStatus; tax_type: TaxType }>> {
  const numbers = candidates.map((c) => c.entry.business_number).filter((n): n is string => Boolean(n));
  const out = new Map<string, { status: BusinessStatus; tax_type: TaxType }>();
  if (!numbers.length) return out;
  const checkedAt = (deps.now ?? (() => new Date()))().toISOString();
  try {
    const items = await deps.nts.checkStatus(numbers);
    for (const item of items) {
      const result = buildStatusResult(item.b_no, item, { cache: false, checkedAt });
      out.set(item.b_no, { status: result.status, tax_type: result.tax_type });
    }
  } catch {
    // Upstream trouble degrades the evidence, never the candidate list.
  }
  return out;
}

export async function searchBusinesses(
  deps: SearchDeps,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResponse> {
  const index = await deps.loadIndex();
  const ranked = searchIndex(index, query, { limit: opts.limit ?? 5 });
  if (!ranked.length) {
    // An empty result must read as an answer, not a malfunction: an agent
    // that cannot tell "no such company" from "the lookup broke" will either
    // retry forever or report a company as nonexistent when we simply failed.
    // The transport says the same thing — 200 here, 503 when we actually fail.
    return {
      query,
      candidates: [],
      note:
        'No company in the index matches this name. This is a definitive empty result, not an error: the ' +
        'index covers DART disclosure filers and registered public-procurement vendors, so a business in ' +
        'neither — a very small or newly founded one — may exist without appearing here. If you already ' +
        'know the 10-digit registration number, use the status or verify tools instead.',
    };
  }

  await resolveNumbers(deps, ranked);
  const evidence = opts.full ? await fetchEvidence(deps, ranked) : new Map();

  const candidates: SearchCandidate[] = ranked.map((c) => {
    const entry = c.entry;
    const base: SearchCandidate = {
      business_number: entry.business_number ?? null,
      name: entry.name,
      ...(entry.name_en ? { name_en: entry.name_en } : {}),
      confidence: c.confidence,
      match: { type: c.match.type, field: c.match.field },
    };
    if (!opts.full) return base;

    const live = entry.business_number ? evidence.get(entry.business_number) : undefined;
    return {
      ...base,
      evidence: {
        ...(live ? { status: live.status, tax_type: live.tax_type } : {}),
        ...(entry.region ? { region: entry.region } : {}),
        ...(entry.listed === undefined ? {} : { listed: entry.listed }),
      },
    };
  });

  const note = disambiguationNote(ranked);
  return {
    query,
    candidates,
    ...(note ? { note } : {}),
    ...(opts.full ? { source: 'Korea National Tax Service (NTS), DART, Public Procurement Service' } : {}),
  };
}

/** Memoizing loader so the index is read from storage once per process. */
export function memoizeIndex(load: () => Promise<NameIndexEntry[]>): () => Promise<NameIndexEntry[]> {
  let pending: Promise<NameIndexEntry[]> | null = null;
  return () => {
    pending ??= load().catch((err) => {
      pending = null; // a failed load must not be cached forever
      throw err;
    });
    return pending;
  };
}
