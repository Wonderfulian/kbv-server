/**
 * Name → business number index.
 *
 * KBV's original flaw was that you had to already know the 10-digit number to
 * use it, while a foreign agent typically knows only a company name. This
 * module turns a name (Korean or English) into *candidates*, never a single
 * answer: "Samsung Electronics" matches four distinct companies in DART, and
 * silently picking one would be a confident lie.
 *
 * FIELD MINIMIZATION: an index entry holds at most identity fields — company
 * number, Korean name, English name, DART corp_code. Personal-data-ish fields
 * that the upstreams happily return (representative name above all) are
 * dropped on arrival and never stored, regardless of what the licence allows.
 * Discriminating evidence (status, region, industry) is fetched live at query
 * time and returned without being written down — see the search route.
 */

/** One indexed company. Identity only, by design. */
export interface NameIndexEntry {
  /** 10 digits, no hyphens. Absent until enrichment resolves it (DART). */
  business_number?: string;
  name: string;
  name_en?: string;
  /** DART's 8-digit code, kept so we can resolve business_number later. */
  corp_code?: string;
  /** Listed companies rank above their affiliates for a bare brand query. */
  listed?: boolean;
  source: IndexSource;
}

export type IndexSource = 'dart' | 'g2b';

/** How a candidate matched — the user sees this, so it must be honest. */
export type MatchType = 'exact' | 'prefix' | 'contains';

export interface Candidate {
  entry: NameIndexEntry;
  confidence: number;
  match: { type: MatchType; field: 'name' | 'name_en' };
}

/** Korean legal forms — unambiguous strings, removed before punctuation is. */
const KO_LEGAL_FORM_RE = /주식회사|유한책임회사|유한회사|합자회사|합명회사|재단법인|사단법인|\(주\)|\(유\)|㈜|㈲/g;

/**
 * English legal forms, matched as whole words *after* punctuation becomes
 * whitespace. Doing it in this order is what makes "CO,.LTD" — DART's actual
 * spelling for Samsung — reduce to nothing instead of leaving a stray "co".
 */
const EN_LEGAL_FORM_RE = /\b(?:co|company|corporation|corp|incorporated|inc|limited|ltd|llc|plc)\b/g;

/**
 * Collapses the spelling noise that keeps the same company from matching
 * itself: legal-form suffixes, punctuation, case and spacing. "SAMSUNG
 * ELECTRONICS CO,.LTD" and "Samsung Electronics" both become "samsungelectronics".
 */
export function normalizeName(input: string): string {
  return input
    .toLowerCase()
    .replace(KO_LEGAL_FORM_RE, ' ')
    .replace(/[.,'"`()[\]{}\-_/\\&·•]/g, ' ')
    .replace(EN_LEGAL_FORM_RE, ' ')
    .replace(/\s+/g, '')
    .trim();
}

/** Base score per match type, before source and listing adjustments. */
const MATCH_SCORE: Record<MatchType, number> = {
  exact: 0.9,
  prefix: 0.7,
  contains: 0.5,
};

/**
 * DART is authoritative for corporate identity; the procurement registry is
 * self-reported at registration time, so it ranks a little lower on ties.
 */
const SOURCE_WEIGHT: Record<IndexSource, number> = {
  dart: 0.05,
  g2b: 0.0,
};

function classify(needle: string, hay: string): MatchType | null {
  if (!hay) return null;
  if (hay === needle) return 'exact';
  if (hay.startsWith(needle)) return 'prefix';
  if (hay.includes(needle)) return 'contains';
  return null;
}

function score(match: MatchType, entry: NameIndexEntry): number {
  const base = MATCH_SCORE[match] + SOURCE_WEIGHT[entry.source];
  // A listed company is the likeliest referent of a bare brand name, and its
  // identity is publicly verifiable — worth a nudge, never a free pass.
  const listed = entry.listed ? 0.05 : 0;
  return Math.min(1, Number((base + listed).toFixed(3)));
}

export interface SearchOptions {
  /** Max candidates returned (the caller pays per call, not per candidate). */
  limit?: number;
  /** Drop candidates below this confidence. */
  minConfidence?: number;
}

/**
 * Ranks index entries against a query. Both name fields are tried and the
 * stronger match wins, so an English query still finds a company indexed
 * under its Korean name when the two coincide.
 */
export function searchIndex(entries: NameIndexEntry[], query: string, opts: SearchOptions = {}): Candidate[] {
  const needle = normalizeName(query);
  if (!needle) return [];
  const limit = opts.limit ?? 5;
  const minConfidence = opts.minConfidence ?? 0;

  const found: Candidate[] = [];
  for (const entry of entries) {
    const byKo = classify(needle, normalizeName(entry.name));
    const byEn = entry.name_en ? classify(needle, normalizeName(entry.name_en)) : null;
    let best: Candidate | null = null;
    for (const [type, field] of [
      [byKo, 'name'],
      [byEn, 'name_en'],
    ] as const) {
      if (!type) continue;
      const confidence = score(type, entry);
      if (!best || confidence > best.confidence) best = { entry, confidence, match: { type, field } };
    }
    if (best && best.confidence >= minConfidence) found.push(best);
  }

  return found
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      // Stable, explainable tie-break: resolved numbers first, then shorter
      // names (a parent company's name is a prefix of its subsidiaries').
      const resolved = Number(Boolean(b.entry.business_number)) - Number(Boolean(a.entry.business_number));
      if (resolved !== 0) return resolved;
      return a.entry.name.length - b.entry.name.length;
    })
    .slice(0, limit);
}

/**
 * Human-readable note for ambiguous results — agents act on text, so the
 * ambiguity has to be stated, not implied by an array length.
 */
export function disambiguationNote(candidates: Candidate[]): string | undefined {
  if (candidates.length < 2) return undefined;
  const top = candidates[0];
  const tied = candidates.filter((c) => c.confidence === top.confidence).length;
  if (tied < 2) return undefined;
  return `${tied} companies match this name equally well; they are distinct legal entities. Compare the evidence fields before acting.`;
}
