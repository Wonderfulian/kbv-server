/**
 * Builds the name → business number index (see name-index.ts), run as a Cloud
 * Run Job on the server's own image, like the snapshot job.
 *
 * DART gives identity for ~120k companies in a single bulk call, but the
 * business number only comes from a per-company call capped near 20,000/day.
 * Enriching everything up front would take a week before the feature could
 * ship, so the build is *progressive*: the bulk identity lands immediately and
 * each run resolves another slice of numbers, newest-listed first. Numbers
 * already resolved are carried over and never re-fetched.
 *
 *   NAME_INDEX_BUCKET   GCS bucket (production)
 *   NAME_INDEX_DIR      local directory instead of GCS (dry runs)
 *   DART_API_KEY        OpenDART key
 *   DART_ENRICH_LIMIT   business numbers to resolve this run (default 1000)
 *   DART_ENRICH_CONCURRENCY  parallel company.json calls (default 4)
 */

import dotenv from 'dotenv';
import { createDartClient, type DartClient, type DartCorp } from './dart.js';
import type { NameIndexEntry } from './name-index.js';
import { GcsNameIndexStore, LocalNameIndexStore, type NameIndexStore } from './name-index-store.js';

/**
 * Folds a fresh DART pull into the existing index. Identity fields follow the
 * upstream (companies rename); resolved business numbers are kept, because
 * they cost a rate-limited call each and effectively never change.
 */
export function mergeIndex(existing: NameIndexEntry[], corps: DartCorp[]): NameIndexEntry[] {
  const resolved = new Map(
    existing.filter((e) => e.source === 'dart' && e.corp_code && e.business_number).map((e) => [e.corp_code, e.business_number]),
  );
  const fromDart: NameIndexEntry[] = corps.map((c) => ({
    corp_code: c.corp_code,
    name: c.name,
    ...(c.name_en ? { name_en: c.name_en } : {}),
    ...(resolved.get(c.corp_code) ? { business_number: resolved.get(c.corp_code) } : {}),
    listed: c.listed,
    source: 'dart' as const,
  }));
  // Entries from other sources (e.g. the procurement registry) pass through
  // untouched — this job only owns the DART slice.
  return [...fromDart, ...existing.filter((e) => e.source !== 'dart')];
}

/** Picks which entries to spend today's DART calls on. */
export function selectForEnrichment(entries: NameIndexEntry[], limit: number): NameIndexEntry[] {
  return entries
    .filter((e) => e.source === 'dart' && e.corp_code && !e.business_number)
    .sort((a, b) => Number(Boolean(b.listed)) - Number(Boolean(a.listed)))
    .slice(0, limit);
}

export interface EnrichResult {
  attempted: number;
  resolved: number;
  missing: number;
  failed: number;
}

/** Resolves business numbers in place, tolerating per-company failure. */
export async function enrich(
  dart: DartClient,
  targets: NameIndexEntry[],
  concurrency: number,
  log: (info: Record<string, unknown>) => void,
): Promise<EnrichResult> {
  const result: EnrichResult = { attempted: targets.length, resolved: 0, missing: 0, failed: 0 };
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const entry = targets[cursor++];
      if (!entry) return;
      try {
        const number = await dart.fetchBusinessNumber(entry.corp_code as string);
        if (number) {
          entry.business_number = number;
          result.resolved++;
        } else {
          result.missing++;
        }
      } catch (err) {
        result.failed++;
        log({ event: 'index_enrich_failed', corp_code: entry.corp_code, error: (err as Error).message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, targets.length)) }, worker));
  return result;
}

export async function buildIndex(deps: {
  dart: DartClient;
  store: NameIndexStore;
  enrichLimit: number;
  concurrency: number;
  log?: (info: Record<string, unknown>) => void;
}): Promise<Record<string, unknown>> {
  const log = deps.log ?? (() => {});
  const existing = await deps.store.read();
  const corps = await deps.dart.fetchCorpCodes();
  const merged = mergeIndex(existing, corps);

  const targets = selectForEnrichment(merged, deps.enrichLimit);
  const enriched = await enrich(deps.dart, targets, deps.concurrency, log);
  await deps.store.write(merged);

  const withNumber = merged.filter((e) => e.business_number).length;
  const summary = {
    event: 'index_build_done',
    total: merged.length,
    with_english_name: merged.filter((e) => e.name_en).length,
    with_business_number: withNumber,
    remaining_to_resolve: merged.length - withNumber,
    ...enriched,
  };
  log(summary);
  return summary;
}

// --- entry point -----------------------------------------------------------

if (process.env.VITEST === undefined && import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  dotenv.config({ quiet: true });

  const apiKey = process.env.DART_API_KEY;
  const bucket = process.env.NAME_INDEX_BUCKET;
  const dir = process.env.NAME_INDEX_DIR;
  if (!apiKey) {
    console.error('FATAL: DART_API_KEY is not set.');
    process.exit(1);
  }
  if (!bucket && !dir) {
    console.error('FATAL: set NAME_INDEX_BUCKET (production) or NAME_INDEX_DIR (dry run).');
    process.exit(1);
  }

  try {
    await buildIndex({
      dart: createDartClient({ apiKey }),
      store: bucket ? new GcsNameIndexStore(bucket) : new LocalNameIndexStore(dir as string),
      enrichLimit: Number(process.env.DART_ENRICH_LIMIT ?? 1000),
      concurrency: Number(process.env.DART_ENRICH_CONCURRENCY ?? 4),
      log: (info) => console.log(JSON.stringify(info)),
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'index_build_failed', error: (err as Error).message }));
    process.exit(1);
  }
}
