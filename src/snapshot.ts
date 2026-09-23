/**
 * Daily status snapshot — the asset the upstream cannot sell us.
 *
 * The NTS API answers only with a business's *current* status; it keeps no
 * history. Recording our own daily snapshot turns that into a change history
 * ("this supplier closed three weeks ago", "suspended, then reopened") that
 * cannot be bought from the source at any price. Every skipped day is history
 * that can never be recovered, which is why the job runs from whatever corpus
 * is available rather than waiting for a complete one.
 *
 * CORPUS POLICY — PUBLISHED PUBLIC LISTS ONLY.
 * The numbers we snapshot come exclusively from published public datasets
 * (see PUBLIC_CORPUS_SOURCES). Numbers that *users looked up* are never added,
 * under any circumstance: KBV's public privacy promise is that query contents
 * are not stored, and a snapshot corpus is storage that outlives the request.
 * `assertPublicCorpus` enforces this at runtime so that a later change — in
 * this repo or in another session — cannot quietly mix user queries in.
 * If you are tempted to seed the corpus from traffic: don't. Add another
 * published dataset to PUBLIC_CORPUS_SOURCES instead.
 */

import { MAX_BATCH, type NtsClient, type NtsStatusItem } from './nts.js';
import { buildStatusResult, SOURCE, type BusinessStatus, type StatusResult, type TaxType } from './normalize.js';

/** Published datasets we are allowed to build the corpus from. */
export const PUBLIC_CORPUS_SOURCES = {
  g2b_sanctions: 'Public Procurement Service — debarred suppliers (나라장터 부정당제재)',
  g2b_vendors: 'Public Procurement Service — registered procurement vendors (나라장터 조달업체)',
  ftc_online_sellers: 'Fair Trade Commission — registered online sellers (공정위 통신판매사업자)',
} as const;

export type PublicCorpusSource = keyof typeof PUBLIC_CORPUS_SOURCES;

export interface CorpusEntry {
  business_number: string;
  /** Which published dataset this number came from — never a user query. */
  corpus_source: PublicCorpusSource;
}

/** One business, as observed on one day. */
export interface SnapshotRecord {
  business_number: string;
  status: BusinessStatus;
  tax_type: TaxType;
  closed_date: string | null;
  /** Data origin (the NTS), on every row so exports are self-describing. */
  source: typeof SOURCE;
  /** Corpus provenance: which public list put this number in scope. */
  corpus_source: PublicCorpusSource;
  /** When we observed it (ISO 8601 UTC). */
  collected_at: string;
}

/** Tracked fields; a change in any of them is a signal worth selling. */
export const TRACKED_FIELDS = ['status', 'tax_type', 'closed_date'] as const;
export type TrackedField = (typeof TRACKED_FIELDS)[number];

/**
 * A single observed transition. Carries both sides and both timestamps, so a
 * buyer sees the evidence rather than just the claim.
 */
export interface ChangeRecord {
  business_number: string;
  corpus_source: PublicCorpusSource;
  /** 'first_seen' marks a number entering the corpus (previous is null). */
  field: TrackedField | 'first_seen';
  previous: string | null;
  current: string | null;
  /** When the previous value was observed; null for first_seen. */
  previous_seen_at: string | null;
  /** When this run observed the new value. */
  detected_at: string;
  source: typeof SOURCE;
}

export interface SnapshotStore {
  /** Corpus for this run. Must contain only PUBLIC_CORPUS_SOURCES entries. */
  readCorpus(): Promise<CorpusEntry[]>;
  /** Most recent snapshot strictly before `date` (YYYY-MM-DD), if any. */
  readLatestSnapshotBefore(date: string): Promise<{ date: string; records: SnapshotRecord[] } | null>;
  writeSnapshot(date: string, records: SnapshotRecord[]): Promise<void>;
  writeChanges(date: string, changes: ChangeRecord[]): Promise<void>;
}

export interface SnapshotDeps {
  nts: NtsClient;
  store: SnapshotStore;
  /** Injected for tests; defaults to the real clock. */
  now?: () => Date;
  /** Parallel NTS batches. Small on purpose — the job is not latency-bound. */
  concurrency?: number;
  log?: (info: Record<string, unknown>) => void;
}

export interface SnapshotSummary {
  date: string;
  corpus_size: number;
  observed: number;
  failed_batches: number;
  changes: number;
  first_seen: number;
  compared_with: string | null;
}

/**
 * Rejects a corpus containing anything but published public lists — the guard
 * behind the corpus policy in this file's header.
 */
export function assertPublicCorpus(entries: CorpusEntry[]): void {
  for (const entry of entries) {
    if (!(entry.corpus_source in PUBLIC_CORPUS_SOURCES)) {
      throw new Error(
        `corpus policy violation: "${String(entry.corpus_source)}" is not a published public dataset. ` +
          'Only PUBLIC_CORPUS_SOURCES may be snapshotted — user-queried numbers must never be stored.',
      );
    }
  }
}

/** UTC calendar day — the same boundary the free tier and NTS updates use. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function fieldValue(record: SnapshotRecord, field: TrackedField): string | null {
  const value = record[field];
  return value === null ? null : String(value);
}

/**
 * Compares two days of observations. Numbers missing from `previous` are
 * reported as 'first_seen'; numbers that left the corpus are simply absent —
 * a dataset dropping a row is not a fact about the business.
 */
export function diffSnapshots(
  previous: { date: string; records: SnapshotRecord[] } | null,
  current: SnapshotRecord[],
): ChangeRecord[] {
  const before = new Map((previous?.records ?? []).map((r) => [r.business_number, r]));
  const changes: ChangeRecord[] = [];

  for (const record of current) {
    const prev = before.get(record.business_number);
    if (!prev) {
      // Entering the corpus is not a status change, but recording it keeps the
      // history self-explanatory — no silent appearances.
      changes.push({
        business_number: record.business_number,
        corpus_source: record.corpus_source,
        field: 'first_seen',
        previous: null,
        current: record.status,
        previous_seen_at: null,
        detected_at: record.collected_at,
        source: SOURCE,
      });
      continue;
    }
    for (const field of TRACKED_FIELDS) {
      const was = fieldValue(prev, field);
      const is = fieldValue(record, field);
      if (was === is) continue;
      changes.push({
        business_number: record.business_number,
        corpus_source: record.corpus_source,
        field,
        previous: was,
        current: is,
        previous_seen_at: prev.collected_at,
        detected_at: record.collected_at,
        source: SOURCE,
      });
    }
  }
  return changes;
}

/** Runs NTS batches with bounded parallelism, tolerating per-batch failure. */
async function observe(
  nts: NtsClient,
  entries: CorpusEntry[],
  collectedAt: string,
  concurrency: number,
  log: (info: Record<string, unknown>) => void,
): Promise<{ records: SnapshotRecord[]; failedBatches: number }> {
  const sourceOf = new Map(entries.map((e) => [e.business_number, e.corpus_source]));
  const batches = chunk([...sourceOf.keys()], MAX_BATCH);
  const records: SnapshotRecord[] = [];
  let failedBatches = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= batches.length) return;
      const numbers = batches[index];
      try {
        const items = await nts.checkStatus(numbers);
        const byNumber = new Map<string, NtsStatusItem>(items.map((i) => [i.b_no, i]));
        for (const number of numbers) {
          const item = byNumber.get(number);
          if (!item) continue; // upstream omitted it; the next run picks it up
          const status: StatusResult = buildStatusResult(number, item, { cache: false, checkedAt: collectedAt });
          records.push({
            business_number: status.business_number,
            status: status.status,
            tax_type: status.tax_type,
            closed_date: status.closed_date,
            source: SOURCE,
            corpus_source: sourceOf.get(number) as PublicCorpusSource,
            collected_at: collectedAt,
          });
        }
      } catch (err) {
        // One bad batch must not cost us the whole day's history.
        failedBatches++;
        log({ event: 'snapshot_batch_failed', batch: index, size: numbers.length, error: (err as Error).message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, worker));
  return { records, failedBatches };
}

/**
 * One day's run: read corpus, observe every number, diff against the previous
 * snapshot, persist both files. Idempotent per day (a re-run overwrites the
 * same date), so retrying after a crash is safe.
 */
export async function runSnapshot(deps: SnapshotDeps): Promise<SnapshotSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const date = utcDate(now);
  const collectedAt = now.toISOString();
  const log = deps.log ?? (() => {});

  const corpus = await deps.store.readCorpus();
  assertPublicCorpus(corpus);

  const { records, failedBatches } = await observe(deps.nts, corpus, collectedAt, deps.concurrency ?? 4, log);
  const previous = await deps.store.readLatestSnapshotBefore(date);
  const changes = diffSnapshots(previous, records);

  await deps.store.writeSnapshot(date, records);
  await deps.store.writeChanges(date, changes);

  const summary: SnapshotSummary = {
    date,
    corpus_size: corpus.length,
    observed: records.length,
    failed_batches: failedBatches,
    changes: changes.filter((c) => c.field !== 'first_seen').length,
    first_seen: changes.filter((c) => c.field === 'first_seen').length,
    compared_with: previous?.date ?? null,
  };
  log({ event: 'snapshot_done', ...summary });
  return summary;
}
