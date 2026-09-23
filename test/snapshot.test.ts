/**
 * Snapshot job tests. The NTS client is faked, so no network and no quota is
 * used; the store is in-memory. The corpus-policy test is the important one:
 * it is the guard that keeps user-queried numbers out of stored history.
 */

import { describe, expect, it } from 'vitest';
import type { NtsClient, NtsStatusItem } from '../src/nts.js';
import {
  assertPublicCorpus,
  diffSnapshots,
  runSnapshot,
  utcDate,
  type ChangeRecord,
  type CorpusEntry,
  type SnapshotRecord,
  type SnapshotStore,
} from '../src/snapshot.js';

const A = '1234567890';
const B = '2345678901';

function fakeNts(items: Record<string, NtsStatusItem>, onCall?: (nos: string[]) => void): NtsClient {
  return {
    async checkStatus(bNos) {
      onCall?.(bNos);
      return bNos.map((b) => items[b]).filter(Boolean);
    },
    async validate() {
      return [];
    },
  };
}

class MemoryStore implements SnapshotStore {
  snapshots = new Map<string, SnapshotRecord[]>();
  changes = new Map<string, ChangeRecord[]>();
  constructor(private corpus: CorpusEntry[]) {}
  async readCorpus() {
    return this.corpus;
  }
  async readLatestSnapshotBefore(date: string) {
    const previous = [...this.snapshots.keys()].filter((d) => d < date).sort().at(-1);
    return previous ? { date: previous, records: this.snapshots.get(previous) as SnapshotRecord[] } : null;
  }
  async writeSnapshot(date: string, records: SnapshotRecord[]) {
    this.snapshots.set(date, records);
  }
  async writeChanges(date: string, changes: ChangeRecord[]) {
    this.changes.set(date, changes);
  }
}

const active: NtsStatusItem = { b_no: A, b_stt_cd: '01', tax_type_cd: '01' };
const closed: NtsStatusItem = { b_no: A, b_stt_cd: '03', tax_type_cd: '01', end_dt: '20260920' };

describe('corpus policy', () => {
  it('accepts published public datasets', () => {
    expect(() => assertPublicCorpus([{ business_number: A, corpus_source: 'g2b_sanctions' }])).not.toThrow();
  });

  it('rejects anything else — user queries can never enter the corpus', () => {
    const smuggled = [{ business_number: A, corpus_source: 'user_lookups' }] as unknown as CorpusEntry[];
    expect(() => assertPublicCorpus(smuggled)).toThrow(/corpus policy violation/);
  });
});

describe('runSnapshot', () => {
  const corpus: CorpusEntry[] = [
    { business_number: A, corpus_source: 'g2b_sanctions' },
    { business_number: B, corpus_source: 'g2b_vendors' },
  ];

  it('records provenance and collection time on every row', async () => {
    const store = new MemoryStore(corpus);
    const nts = fakeNts({ [A]: active, [B]: { b_no: B, b_stt_cd: '01', tax_type_cd: '02' } });
    const summary = await runSnapshot({ nts, store, now: () => new Date('2026-09-24T00:05:00Z') });

    expect(summary.date).toBe('2026-09-24');
    expect(summary.observed).toBe(2);
    const rows = store.snapshots.get('2026-09-24') as SnapshotRecord[];
    expect(rows[0]).toMatchObject({
      business_number: A,
      status: 'active',
      source: 'Korea National Tax Service (NTS)',
      corpus_source: 'g2b_sanctions',
      collected_at: '2026-09-24T00:05:00.000Z',
    });
    expect(rows.find((r) => r.business_number === B)?.corpus_source).toBe('g2b_vendors');
  });

  it('first run reports every number as first_seen, with no prior value', async () => {
    const store = new MemoryStore(corpus);
    const nts = fakeNts({ [A]: active, [B]: { b_no: B, b_stt_cd: '01', tax_type_cd: '01' } });
    const summary = await runSnapshot({ nts, store, now: () => new Date('2026-09-24T00:05:00Z') });

    expect(summary.first_seen).toBe(2);
    expect(summary.changes).toBe(0);
    expect(summary.compared_with).toBeNull();
    const first = (store.changes.get('2026-09-24') as ChangeRecord[])[0];
    expect(first).toMatchObject({ field: 'first_seen', previous: null, previous_seen_at: null, current: 'active' });
  });

  it('keeps both sides and both timestamps when a status changes', async () => {
    const store = new MemoryStore(corpus);
    await runSnapshot({
      nts: fakeNts({ [A]: active, [B]: { b_no: B, b_stt_cd: '01', tax_type_cd: '01' } }),
      store,
      now: () => new Date('2026-09-24T00:05:00Z'),
    });
    const summary = await runSnapshot({
      nts: fakeNts({ [A]: closed, [B]: { b_no: B, b_stt_cd: '01', tax_type_cd: '01' } }),
      store,
      now: () => new Date('2026-09-25T00:05:00Z'),
    });

    expect(summary.compared_with).toBe('2026-09-24');
    const changes = store.changes.get('2026-09-25') as ChangeRecord[];
    const statusChange = changes.find((c) => c.field === 'status');
    expect(statusChange).toMatchObject({
      business_number: A,
      previous: 'active',
      current: 'closed',
      previous_seen_at: '2026-09-24T00:05:00.000Z',
      detected_at: '2026-09-25T00:05:00.000Z',
      corpus_source: 'g2b_sanctions',
      source: 'Korea National Tax Service (NTS)',
    });
    // The closure date appearing is its own tracked transition.
    expect(changes.find((c) => c.field === 'closed_date')).toMatchObject({
      previous: null,
      current: '2026-09-20',
    });
  });

  it('an unchanged day produces no change rows', async () => {
    const store = new MemoryStore(corpus);
    const nts = fakeNts({ [A]: active, [B]: { b_no: B, b_stt_cd: '01', tax_type_cd: '01' } });
    await runSnapshot({ nts, store, now: () => new Date('2026-09-24T00:05:00Z') });
    await runSnapshot({ nts, store, now: () => new Date('2026-09-25T00:05:00Z') });

    expect(store.changes.get('2026-09-25')).toHaveLength(0);
  });

  it('survives a failed batch instead of losing the day', async () => {
    const store = new MemoryStore(corpus);
    const nts: NtsClient = {
      async checkStatus(bNos) {
        throw new Error('upstream 503 for ' + bNos.length);
      },
      async validate() {
        return [];
      },
    };
    const summary = await runSnapshot({ nts, store, now: () => new Date('2026-09-24T00:05:00Z') });

    expect(summary.failed_batches).toBe(1);
    expect(summary.observed).toBe(0);
    expect(store.snapshots.get('2026-09-24')).toEqual([]); // the day still exists
  });

  it('chunks the corpus into NTS-sized batches', async () => {
    const big: CorpusEntry[] = Array.from({ length: 250 }, (_, i) => ({
      business_number: String(1000000000 + i),
      corpus_source: 'g2b_vendors' as const,
    }));
    const sizes: number[] = [];
    const items = Object.fromEntries(
      big.map((e) => [e.business_number, { b_no: e.business_number, b_stt_cd: '01', tax_type_cd: '01' }]),
    );
    await runSnapshot({
      nts: fakeNts(items, (nos) => sizes.push(nos.length)),
      store: new MemoryStore(big),
      now: () => new Date('2026-09-24T00:05:00Z'),
      concurrency: 1,
    });

    expect(sizes).toEqual([100, 100, 50]);
  });
});

describe('diffSnapshots', () => {
  it('ignores numbers that left the corpus', () => {
    const previous = {
      date: '2026-09-24',
      records: [
        {
          business_number: A,
          status: 'active',
          tax_type: 'general',
          closed_date: null,
          source: 'Korea National Tax Service (NTS)',
          corpus_source: 'g2b_vendors',
          collected_at: '2026-09-24T00:05:00.000Z',
        } as SnapshotRecord,
      ],
    };
    expect(diffSnapshots(previous, [])).toEqual([]);
  });
});

describe('utcDate', () => {
  it('uses the UTC day boundary', () => {
    expect(utcDate(new Date('2026-09-24T23:59:59Z'))).toBe('2026-09-24');
    expect(utcDate(new Date('2026-09-25T00:00:00Z'))).toBe('2026-09-25');
  });
});
