/**
 * Collects the procurement vendor registry into two artefacts:
 *
 *   1. the `g2b` slice of the name index — Korean-name coverage for the small
 *      and mid-sized companies DART never sees
 *   2. the snapshot corpus (`corpus/current.jsonl`) — the published list of
 *      numbers the daily status job is allowed to observe (see snapshot.ts)
 *
 * The upstream can only be read a month at a time and its date filter is the
 * registration date, so a backfill walks months backwards. At ~2,900 vendors
 * a month and 999 rows per request that is about three calls per month —
 * roughly 900 calls for the registry's entire history, well inside the daily
 * quota. Incremental runs afterwards need only the current month.
 *
 *   NAME_INDEX_BUCKET / NAME_INDEX_DIR   where the index lives
 *   SNAPSHOT_BUCKET / SNAPSHOT_DIR       where the corpus lives
 *   G2B_FROM  first month to collect, YYYY-MM (default: 12 months back)
 *   G2B_TO    last month to collect, YYYY-MM (default: current month)
 */

import dotenv from 'dotenv';
import { createG2bClient, monthWindows, type G2bClient, type G2bVendor } from './g2b.js';
import type { NameIndexEntry } from './name-index.js';
import { GcsNameIndexStore, LocalNameIndexStore, type NameIndexStore } from './name-index-store.js';
import { GcsSnapshotStore, LocalSnapshotStore } from './snapshot-store.js';
import type { CorpusEntry, SnapshotStore } from './snapshot.js';

/**
 * Keeps one row per business number. Windows arrive newest-first, so the
 * first sighting is the most recent registration — the name most likely to
 * be current.
 */
export function dedupeVendors(vendors: G2bVendor[]): G2bVendor[] {
  const seen = new Map<string, G2bVendor>();
  for (const v of vendors) if (!seen.has(v.business_number)) seen.set(v.business_number, v);
  return [...seen.values()];
}

/** Replaces the g2b slice wholesale; the DART slice is left untouched. */
export function mergeVendorsIntoIndex(existing: NameIndexEntry[], vendors: G2bVendor[]): NameIndexEntry[] {
  const fromG2b: NameIndexEntry[] = vendors.map((v) => ({
    business_number: v.business_number,
    name: v.name,
    ...(v.name_en ? { name_en: v.name_en } : {}),
    ...(v.region ? { region: v.region } : {}),
    source: 'g2b' as const,
  }));
  return [...existing.filter((e) => e.source !== 'g2b'), ...fromG2b];
}

/** The published-list corpus the snapshot job observes daily. */
export function toCorpus(vendors: G2bVendor[]): CorpusEntry[] {
  return vendors.map((v) => ({ business_number: v.business_number, corpus_source: 'g2b_vendors' as const }));
}

export interface CollectDeps {
  g2b: G2bClient;
  indexStore: NameIndexStore;
  snapshotStore: Pick<SnapshotStore, 'readCorpus' | 'writeCorpus'>;
  from: Date;
  to: Date;
  log?: (info: Record<string, unknown>) => void;
}

export async function collectVendors(deps: CollectDeps): Promise<Record<string, unknown>> {
  const log = deps.log ?? (() => {});
  const windows = monthWindows(deps.from, deps.to);
  const collected: G2bVendor[] = [];
  let failedMonths = 0;

  for (const window of windows) {
    try {
      const rows = await deps.g2b.fetchMonth(window);
      collected.push(...rows);
      log({ event: 'g2b_month_done', month: window.label, rows: rows.length });
    } catch (err) {
      // A single bad month must not discard the months already collected.
      failedMonths++;
      log({ event: 'g2b_month_failed', month: window.label, error: (err as Error).message });
    }
  }

  const vendors = dedupeVendors(collected);
  const index = mergeVendorsIntoIndex(await deps.indexStore.read(), vendors);
  await deps.indexStore.write(index);

  // The corpus keeps numbers from every published list, so merge rather than
  // overwrite — the sanctions list will land here too.
  const existingCorpus = await deps.snapshotStore.readCorpus();
  const kept = existingCorpus.filter((e) => e.corpus_source !== 'g2b_vendors');
  await deps.snapshotStore.writeCorpus([...kept, ...toCorpus(vendors)]);

  const summary = {
    event: 'g2b_collect_done',
    months: windows.length,
    failed_months: failedMonths,
    rows: collected.length,
    unique_vendors: vendors.length,
    with_english_name: vendors.filter((v) => v.name_en).length,
    index_total: index.length,
    corpus_total: kept.length + vendors.length,
  };
  log(summary);
  return summary;
}

/** "YYYY-MM" → first day of that month, UTC. */
export function parseMonth(value: string): Date {
  const m = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`expected YYYY-MM, got "${value}"`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
}

// --- entry point -----------------------------------------------------------

if (process.env.VITEST === undefined && import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  dotenv.config({ quiet: true });

  const serviceKey = process.env.NTS_SERVICE_KEY; // one data.go.kr key, all datasets
  const indexBucket = process.env.NAME_INDEX_BUCKET;
  const indexDir = process.env.NAME_INDEX_DIR;
  const snapshotBucket = process.env.SNAPSHOT_BUCKET;
  const snapshotDir = process.env.SNAPSHOT_DIR;

  if (!serviceKey) {
    console.error('FATAL: NTS_SERVICE_KEY is not set.');
    process.exit(1);
  }
  if (!indexBucket && !indexDir) {
    console.error('FATAL: set NAME_INDEX_BUCKET or NAME_INDEX_DIR.');
    process.exit(1);
  }
  if (!snapshotBucket && !snapshotDir) {
    console.error('FATAL: set SNAPSHOT_BUCKET or SNAPSHOT_DIR.');
    process.exit(1);
  }

  const now = new Date();
  const to = process.env.G2B_TO ? parseMonth(process.env.G2B_TO) : now;
  const from = process.env.G2B_FROM
    ? parseMonth(process.env.G2B_FROM)
    : new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1));

  try {
    await collectVendors({
      g2b: createG2bClient({ serviceKey }),
      indexStore: indexBucket ? new GcsNameIndexStore(indexBucket) : new LocalNameIndexStore(indexDir as string),
      snapshotStore: snapshotBucket
        ? new GcsSnapshotStore(snapshotBucket)
        : new LocalSnapshotStore(snapshotDir as string),
      from,
      to,
      log: (info) => console.log(JSON.stringify(info)),
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'g2b_collect_failed', error: (err as Error).message }));
    process.exit(1);
  }
}
