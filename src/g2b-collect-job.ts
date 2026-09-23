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
import { createG2bClient, monthWindows, type G2bClient, type G2bSanction, type G2bVendor } from './g2b.js';
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

export const PROGRESS_PATH = 'progress/g2b-collect.json';
export const SANCTIONS_PATH = 'sanctions/current.json';

export interface CollectProgress {
  started_at: string;
  updated_at: string;
  total_months: number;
  completed_months: string[];
  failed_months: string[];
  vendors_collected: number;
}

export interface CollectDeps {
  g2b: G2bClient;
  indexStore: NameIndexStore;
  snapshotStore: Pick<SnapshotStore, 'readCorpus' | 'writeCorpus'>;
  from: Date;
  to: Date;
  /**
   * Vendors registered within this many months of `to` go into the daily
   * snapshot corpus. The rest stay searchable in the index but are not polled
   * every day — the corpus size is bounded by the upstream's daily quota, the
   * index is not.
   */
  corpusMonths?: number;
  /** Resume: months already collected are skipped. */
  resume?: boolean;
  now?: () => Date;
  log?: (info: Record<string, unknown>) => void;
}

/** Months (newest-first labels) that belong in the daily snapshot corpus. */
export function corpusWindowLabels(labels: string[], corpusMonths: number): Set<string> {
  return new Set(labels.slice(0, Math.max(0, corpusMonths)));
}

export async function collectVendors(deps: CollectDeps): Promise<Record<string, unknown>> {
  const log = deps.log ?? (() => {});
  const now = (deps.now ?? (() => new Date()))();
  const windows = monthWindows(deps.from, deps.to);
  const corpusMonths = deps.corpusMonths ?? 60;
  const recentLabels = corpusWindowLabels(
    windows.map((w) => w.label),
    corpusMonths,
  );

  const prior = deps.resume ? await deps.indexStore.readJson<CollectProgress>(PROGRESS_PATH) : null;
  const done = new Set(prior?.completed_months ?? []);
  const progress: CollectProgress = {
    started_at: prior?.started_at ?? now.toISOString(),
    updated_at: now.toISOString(),
    total_months: windows.length,
    completed_months: [...done],
    failed_months: [...(prior?.failed_months ?? [])],
    vendors_collected: prior?.vendors_collected ?? 0,
  };

  const collected: G2bVendor[] = [];
  /** Numbers seen in a window recent enough for daily observation. */
  const recentNumbers = new Set<string>();

  for (const window of windows) {
    if (done.has(window.label)) continue;
    try {
      const rows = await deps.g2b.fetchMonth(window);
      collected.push(...rows);
      if (recentLabels.has(window.label)) for (const row of rows) recentNumbers.add(row.business_number);
      progress.completed_months.push(window.label);
      progress.vendors_collected += rows.length;
      log({ event: 'g2b_month_done', month: window.label, rows: rows.length });
    } catch (err) {
      // A single bad month must not discard the months already collected.
      progress.failed_months.push(window.label);
      log({ event: 'g2b_month_failed', month: window.label, error: (err as Error).message });
    }
    // Checkpoint after every month: a backfill that dies at month 143 of 290
    // must say so rather than leaving the operator to guess.
    progress.updated_at = new Date().toISOString();
    await deps.indexStore.writeJson(PROGRESS_PATH, progress);
  }

  // Debarments: collected across the same span, one call per year. They are
  // the highest-value subjects to watch daily, so they enter the corpus
  // regardless of how long ago the company registered.
  const sanctions = await collectSanctions(deps, windows, log);
  await deps.indexStore.writeJson(SANCTIONS_PATH, { updated_at: now.toISOString(), sanctions });

  const vendors = dedupeVendors(collected);
  const index = mergeVendorsIntoIndex(await deps.indexStore.read(), vendors);
  await deps.indexStore.write(index);

  const existingCorpus = await deps.snapshotStore.readCorpus();
  const kept = existingCorpus.filter((e) => e.corpus_source !== 'g2b_vendors' && e.corpus_source !== 'g2b_sanctions');
  const sanctioned = new Set(sanctions.map((s) => s.business_number));
  const recentVendors = vendors.filter((v) => recentNumbers.has(v.business_number) && !sanctioned.has(v.business_number));
  const corpus: CorpusEntry[] = [
    ...kept,
    ...toCorpus(recentVendors),
    ...[...sanctioned].map((business_number) => ({ business_number, corpus_source: 'g2b_sanctions' as const })),
  ];
  await deps.snapshotStore.writeCorpus(corpus);

  const summary = {
    event: 'g2b_collect_done',
    months: windows.length,
    completed_months: progress.completed_months.length,
    failed_months: progress.failed_months.length,
    rows: collected.length,
    unique_vendors: vendors.length,
    with_english_name: vendors.filter((v) => v.name_en).length,
    sanctions: sanctions.length,
    index_total: index.length,
    corpus_recent_vendors: recentVendors.length,
    corpus_sanctioned: sanctioned.size,
    corpus_total: corpus.length,
  };
  log(summary);
  return summary;
}

/** One call per calendar year across the collected span. */
async function collectSanctions(
  deps: CollectDeps,
  windows: { label: string; from: string; to: string }[],
  log: (info: Record<string, unknown>) => void,
): Promise<G2bSanction[]> {
  if (!windows.length) return [];
  const years = [...new Set(windows.map((w) => w.label.slice(0, 4)))].sort();
  const all: G2bSanction[] = [];
  for (const year of years) {
    try {
      const rows = await deps.g2b.fetchSanctions({ from: `${year}01010000`, to: `${year}12312359` });
      all.push(...rows);
      log({ event: 'g2b_sanctions_year_done', year, rows: rows.length });
    } catch (err) {
      log({ event: 'g2b_sanctions_year_failed', year, error: (err as Error).message });
    }
  }
  // One row per company: a vendor may be debarred more than once, and the
  // corpus only needs the number.
  const seen = new Map<string, G2bSanction>();
  for (const s of all) if (!seen.has(s.business_number)) seen.set(s.business_number, s);
  return [...seen.values()];
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
      corpusMonths: Number(process.env.G2B_CORPUS_MONTHS ?? 60),
      resume: process.env.G2B_RESUME === '1',
      log: (info) => console.log(JSON.stringify(info)),
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'g2b_collect_failed', error: (err as Error).message }));
    process.exit(1);
  }
}
